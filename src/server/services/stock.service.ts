/**
 * Stock movement — receiving, issuing, adjusting and writing off.
 *
 * `inventory.service.ts` owns the item *definition* and cannot change a quantity. This file is
 * the only way a quantity moves, and every path through it appends a ledger row in the same
 * transaction as the movement. There is deliberately no "set the quantity to N" operation: a
 * recount that disagrees with the system is an **adjustment with a reason**, which leaves the
 * correction visible instead of overwriting the disagreement.
 *
 * ── What this service decides, and what the repository decides ──────────────────────────
 *
 * This service decides *policy*: who may move stock, whether the request is coherent, which
 * batches an issue should draw from, and what the linkage means. The repository decides
 * *nothing* except how to apply that atomically on its engine.
 *
 * The split matters most for the availability check. It happens here **and** in the repository,
 * and neither is redundant:
 *
 *   • Here, so the common case — somebody typing 500 when 5 remain — is a clear 400 naming the
 *     shortfall, before any write is attempted.
 *   • There, because the check here is a read and the write comes after it. Two people issuing
 *     the last of a reagent both pass this check. Exactly one passes the engine's.
 *
 * A validation error the user can act on, and a conflict they cannot predict, are different
 * outcomes and get different status codes.
 *
 * ── Expired stock ───────────────────────────────────────────────────────────────────────
 *
 * `planIssue` never allocates from an expired batch, so an item holding 10 L of which 8 L have
 * expired will refuse a 5 L issue while displaying 10 L available. That refusal is the feature.
 * The expired material stays on the books, and therefore visibly wrong, until somebody writes it
 * off — which is a different and deliberate act.
 */
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/server/errors/app-error';
import { planIssue } from '@/server/domain/inventory';
import type { Actor } from '@/server/permissions/actor';
import { auditService } from '@/server/audit/audit.service';
import * as inventoryItemRepository from '@/server/repositories/inventory-item.repository';
import type {
  InventoryItemRecord,
  StockResult,
  StockTransactionRecord,
} from '@/server/repositories/inventory-item.repository';
import { InsufficientStockError } from '@/server/repositories/inventory-item.repository';
import * as userRepository from '@/server/repositories/user.repository';
import * as departmentRepository from '@/server/repositories/department.repository';
import * as projectRepository from '@/server/repositories/project.repository';
import * as experimentRepository from '@/server/repositories/experiment.repository';
import type { StockAction, StockIssueTarget } from '@/server/db/models/stock-transaction.model';
import type { RequestMeta } from '@/server/http/request-meta';
import { assertCanReadInventory, assertInventoryPermission } from './inventory-access';

/* ------------------------------------------------------------------ shared validation */

/**
 * A quantity is finite, positive, and a multiple of 0.001.
 *
 * The same rule `quantitySchema` enforces at the edge, restated here because this service is
 * also reachable from the expiry job and the seed script, which do not go through Zod. Three
 * decimals is the precision a balance or a pipette actually reports.
 *
 * ── Why a float total is safe here, when usually it is not ──────────────────────────────
 *
 * Running totals that must reconcile with a physical shelf are the classic case *against*
 * binary floating point. It holds because of the granularity: every value is a multiple of
 * 0.001 and capped at 1e9, so `quantity × 1000` is an integer below 1e12 — comfortably inside
 * the 2^53 range a double represents exactly. Sums and differences of such values are exact.
 *
 * The cap is what makes that an argument rather than a hope, which is why `quantitySchema`
 * carries one. SQLite stores these in a column declared `integer`; its type affinity keeps a
 * value that cannot be losslessly converted as a real, so 2.5 survives the round trip.
 */
const QUANTITY_CAP = 1_000_000_000;

function assertQuantity(quantity: number, field = 'quantity'): void {
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    quantity > QUANTITY_CAP ||
    !Number.isInteger(Math.round(quantity * 1000))
  ) {
    throw new ValidationError(`Enter a ${field} greater than zero, to at most three decimals`);
  }
}

/**
 * Refuses a movement dated in the future.
 *
 * A backdated receipt is legitimate — the delivery arrived on Friday and was entered on Monday —
 * so the past is open. The future is not: a movement that has not happened yet would count stock
 * that is not on the shelf, and the history would be unsortable against the audit log.
 */
function resolvePerformedAt(value: Date | undefined, now: Date): Date {
  if (!value) return now;
  if (value.getTime() > now.getTime()) {
    throw new ValidationError('A stock movement cannot be dated in the future');
  }
  return value;
}

function sanitizeBatchNumber(value: string): string {
  const batchNumber = value.trim();
  if (!batchNumber) throw new ValidationError('Enter the batch number printed on the container');
  if (batchNumber.length > 80) throw new ValidationError('That batch number is too long');
  return batchNumber;
}

/**
 * Loads the item and checks the actor may perform this class of movement on it.
 *
 * Reading the item first is what makes the 404 correct: an id from another organization must be
 * indistinguishable from one that does not exist, so the organization check happens before the
 * permission check and produces `NotFoundError` rather than `ForbiddenError`.
 */
async function resolveItem(
  actor: Actor,
  itemId: string,
  permission: Parameters<typeof assertInventoryPermission>[1],
  message: string,
): Promise<InventoryItemRecord> {
  assertCanReadInventory(actor);

  const item = await inventoryItemRepository.findById(itemId);
  if (!item || item.organizationId !== actor.organizationId) throw new NotFoundError();

  assertInventoryPermission(actor, permission, { departmentId: item.departmentId }, message);

  if (item.status !== 'active') {
    throw new ValidationError(
      `${item.code} is ${item.status} and cannot take stock movements. Reactivate it first.`,
    );
  }

  return item;
}

/** The ledger fields every movement carries about who did it and when. */
function contextFor(actor: Actor, meta: RequestMeta, performedAt: Date) {
  return {
    performedBy: actor.userId,
    performedByName: actor.name,
    performedAt,
    requestId: meta.requestId ?? null,
  };
}

/**
 * Records the movement in the audit log, after it has committed.
 *
 * Deliberately after: an audit row claiming a receipt that rolled back is worse than a missing
 * one, and the ledger — which *is* written inside the transaction — is the authoritative record
 * of stock either way. The same trade-off is documented for file mutations.
 */
async function auditMovement(
  actor: Actor,
  meta: RequestMeta,
  action: StockAction,
  result: StockResult,
): Promise<void> {
  await auditService.recordForActor(actor, meta, {
    action: `inventory.stock_${action}`,
    entityType: 'inventory_item',
    entityId: result.item.id,
    entityLabel: `${result.item.code} — ${result.item.name}`,
    newValue: {
      transactionId: result.transaction.id,
      quantityDelta: result.transaction.quantityDelta,
      previousQuantity: result.transaction.previousQuantity,
      newQuantity: result.transaction.newQuantity,
      batchNumber: result.transaction.batchNumber,
      issuedToLabel: result.transaction.issuedToLabel || undefined,
    },
    severity: action === 'expired' ? 'warning' : 'notice',
  });
}

/* ------------------------------------------------------------------ receive */

export interface ReceiveStockRequest {
  itemId: string;
  quantity: number;
  batchNumber: string;
  expiryDate?: Date | null;
  supplier?: string;
  storageLocation?: string;
  purpose?: string;
  notes?: string;
  performedAt?: Date;
}

export async function receive(
  actor: Actor,
  input: ReceiveStockRequest,
  meta: RequestMeta,
): Promise<StockResult> {
  const now = new Date();
  const item = await resolveItem(
    actor,
    input.itemId,
    'inventory.stock.add',
    'You cannot add stock for this item',
  );

  assertQuantity(input.quantity);
  const batchNumber = sanitizeBatchNumber(input.batchNumber);
  const performedAt = resolvePerformedAt(input.performedAt, now);

  /**
   * Receiving stock that has already expired is refused.
   *
   * Not a warning: the material cannot be issued (see `planIssue`), so accepting it would add a
   * number to the shelf total that nobody can ever draw on, and the item would read as stocked
   * while being unusable. If a delivery genuinely arrives expired it is a supplier problem, and
   * recording it as an adjustment with a reason is the honest way to put it on the books.
   */
  if (input.expiryDate && input.expiryDate.getTime() < now.getTime()) {
    throw new ValidationError(
      'That batch has already expired and cannot be received as usable stock. ' +
        'Record it with a stock adjustment if it must appear on the books.',
    );
  }

  const result = await inventoryItemRepository.receive({
    itemId: item.id,
    quantity: input.quantity,
    batchNumber,
    expiryDate: input.expiryDate ?? null,
    ...(input.supplier !== undefined ? { supplier: input.supplier.trim() } : {}),
    ...(input.storageLocation !== undefined
      ? { storageLocation: input.storageLocation.trim() }
      : {}),
    ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...contextFor(actor, meta, performedAt),
  });

  await auditMovement(actor, meta, 'added', result);
  return result;
}

/* ------------------------------------------------------------------ issue */

export interface IssueStockRequest {
  itemId: string;
  quantity: number;
  issuedToType: StockIssueTarget;
  issuedToUserId?: string;
  issuedToDepartmentId?: string;
  projectId?: string;
  experimentId?: string;
  purpose?: string;
  notes?: string;
  performedAt?: Date;
}

export async function issue(
  actor: Actor,
  input: IssueStockRequest,
  meta: RequestMeta,
): Promise<StockResult> {
  const now = new Date();
  const item = await resolveItem(
    actor,
    input.itemId,
    'inventory.stock.issue',
    'You cannot issue stock for this item',
  );

  assertQuantity(input.quantity);
  const performedAt = resolvePerformedAt(input.performedAt, now);
  const target = await resolveIssueTarget(actor, input);

  const plan = planIssue(item.batches, input.quantity, now);

  if (!plan.satisfied) {
    /**
     * The message distinguishes "not enough stock" from "not enough *issuable* stock".
     *
     * They look identical to somebody reading a screen that says 10 L available, and the remedy
     * is completely different: one is a reorder, the other is a write-off. Saying which is the
     * difference between a useful error and a confusing one.
     */
    const expired = item.availableQuantity - plan.issuableQuantity;
    throw new ValidationError(
      expired > 0
        ? `Only ${plan.issuableQuantity} ${item.unit} can be issued — ${expired} ${item.unit} ` +
          `of the ${item.availableQuantity} in stock have expired and must be written off.`
        : `Only ${plan.issuableQuantity} ${item.unit} remain in stock.`,
    );
  }

  try {
    const result = await inventoryItemRepository.issue({
      itemId: item.id,
      quantity: input.quantity,
      target,
      allocations: plan.entries,
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...contextFor(actor, meta, performedAt),
    });

    await auditMovement(actor, meta, 'issued', result);
    return result;
  } catch (error) {
    // Somebody else took the stock between the plan and the write. A 409, not a 400: the request
    // was valid when it was made and the user could not have known.
    if (error instanceof InsufficientStockError) throw new ConflictError(error.message);
    throw error;
  }
}

/**
 * Resolves and validates what the stock is being issued to.
 *
 * Every reference is checked to exist **and** to belong to the actor's organization. Without
 * that, the issue form is an existence oracle for ids in other companies, and the ledger would
 * carry a project id that no query in this organization can ever resolve — a row that looks
 * complete and explains nothing.
 */
async function resolveIssueTarget(
  actor: Actor,
  input: IssueStockRequest,
): Promise<{
  type: StockIssueTarget;
  userId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  experimentId?: string | null;
  label: string;
}> {
  const labels: string[] = [];
  let userId: string | null = null;
  let departmentId: string | null = null;
  let projectId: string | null = null;
  let experimentId: string | null = null;

  if (input.issuedToUserId) {
    const user = await userRepository.findById(input.issuedToUserId);
    if (!user || user.organizationId !== actor.organizationId) {
      throw new ValidationError('That employee could not be found');
    }
    userId = user.id;
    labels.push(user.name);
  }

  if (input.issuedToDepartmentId) {
    const department = await departmentRepository.findById(input.issuedToDepartmentId);
    if (!department || department.organizationId !== actor.organizationId) {
      throw new ValidationError('That department could not be found');
    }
    departmentId = department.id;
    labels.push(department.name);
  }

  if (input.projectId) {
    const project = await projectRepository.findById(input.projectId);
    if (!project || project.organizationId !== actor.organizationId) {
      throw new ValidationError('That project could not be found');
    }
    projectId = project.id;
    labels.push(project.name);
  }

  if (input.experimentId) {
    const experiment = await experimentRepository.findById(input.experimentId);
    if (!experiment || experiment.organizationId !== actor.organizationId) {
      throw new ValidationError('That experiment could not be found');
    }
    // An experiment that names a different project than the one supplied would produce a ledger
    // row whose two links contradict each other, and the consumption report reads both.
    if (projectId && experiment.projectId && experiment.projectId !== projectId) {
      throw new ValidationError(
        'That experiment belongs to a different project than the one selected',
      );
    }
    experimentId = experiment.id;
    if (!projectId && experiment.projectId) projectId = experiment.projectId;
    labels.push(experiment.title);
  }

  /**
   * The declared target type must actually be populated.
   *
   * Otherwise `issuedToType: 'project'` with no project id produces a row that reports as
   * project consumption and appears in no project's report — the linkage silently missing from
   * exactly the query it exists to serve.
   */
  const required: Record<StockIssueTarget, string | null> = {
    employee: userId,
    department: departmentId,
    project: projectId,
    experiment: experimentId,
  };

  if (!required[input.issuedToType]) {
    throw new ValidationError(`Select the ${input.issuedToType} the stock is being issued to`);
  }

  return {
    type: input.issuedToType,
    userId,
    departmentId,
    projectId,
    experimentId,
    label: labels.join(' · '),
  };
}

/* ------------------------------------------------------------------ adjust */

export interface AdjustStockRequest {
  itemId: string;
  batchNumber: string;
  /** Signed. Negative writes stock off; positive records a recount that found more. */
  delta: number;
  reason: string;
  expiryDate?: Date | null;
  notes?: string;
  performedAt?: Date;
}

export async function adjust(
  actor: Actor,
  input: AdjustStockRequest,
  meta: RequestMeta,
): Promise<StockResult> {
  const now = new Date();
  const item = await resolveItem(
    actor,
    input.itemId,
    'inventory.stock.adjust',
    'You cannot adjust stock for this item',
  );

  if (input.delta === 0) throw new ValidationError('Enter an adjustment other than zero');
  assertQuantity(Math.abs(input.delta), 'adjustment');

  // An adjustment is the one movement with no physical event behind it, so the reason is the
  // only thing that makes the row auditable. It is mandatory for that reason alone.
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError('Explain why this stock is being adjusted');

  const batchNumber = sanitizeBatchNumber(input.batchNumber);
  const performedAt = resolvePerformedAt(input.performedAt, now);

  const batch = item.batches.find((candidate) => candidate.batchNumber === batchNumber);
  if (input.delta < 0) {
    if (!batch) throw new ValidationError(`This item holds no batch "${batchNumber}"`);
    if (batch.quantity < -input.delta) {
      throw new ValidationError(
        `Batch "${batchNumber}" holds ${batch.quantity} ${item.unit}; ` +
          `${-input.delta} cannot be written off.`,
      );
    }
  }

  try {
    const result = await inventoryItemRepository.adjust({
      itemId: item.id,
      batchNumber,
      delta: input.delta,
      reason,
      ...(input.expiryDate !== undefined ? { expiryDate: input.expiryDate } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...contextFor(actor, meta, performedAt),
    });

    await auditMovement(actor, meta, 'adjusted', result);
    return result;
  } catch (error) {
    if (error instanceof InsufficientStockError) throw new ConflictError(error.message);
    throw error;
  }
}

/* ------------------------------------------------------------------ expiry sweep */

/**
 * Writes off every batch past its expiry date, across the organization.
 *
 * Unattended, so it takes no actor — but it is not unauthenticated: the only callers are the
 * scheduled job and an admin-triggered route, and the route asserts the permission before
 * getting here. `performedBy` is null on the resulting rows, which is what distinguishes an
 * automatic write-off from a human one in the history.
 */
export async function sweepExpired(
  organizationId: string,
  options: { now?: Date; performedBy?: string; performedByName?: string } = {},
): Promise<StockTransactionRecord[]> {
  return inventoryItemRepository.expire({
    organizationId,
    now: options.now ?? new Date(),
    performedBy: options.performedBy ?? null,
    ...(options.performedByName ? { performedByName: options.performedByName } : {}),
  });
}

export async function sweepExpiredForActor(
  actor: Actor,
  meta: RequestMeta,
): Promise<StockTransactionRecord[]> {
  assertCanReadInventory(actor);
  // Company scope only. A department store manager writing off the whole organization's expired
  // stock in one click is not a department-scoped action, whatever their grant says about their
  // own shelves.
  if (!actor.isSuperAdmin && !actor.grants.some((grant) =>
    grant.scopeType === 'company' && grant.permissions.includes('inventory.stock.adjust'))) {
    throw new ForbiddenError('Only a company-wide inventory administrator can run the expiry sweep');
  }

  const written = await sweepExpired(actor.organizationId, {
    performedBy: actor.userId,
    performedByName: actor.name,
  });

  if (written.length > 0) {
    await auditService.recordForActor(actor, meta, {
      action: 'inventory.stock_expired',
      entityType: 'inventory_item',
      entityId: actor.organizationId,
      entityLabel: `Expiry sweep — ${written.length} item(s)`,
      newValue: { itemsWrittenOff: written.length },
      severity: 'warning',
    });
  }

  return written;
}

/* ------------------------------------------------------------------ history */

export interface StockHistoryRequest {
  itemId?: string;
  action?: StockAction;
  projectId?: string;
  experimentId?: string;
  issuedToUserId?: string;
  performedBy?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

/**
 * The stock ledger, filtered.
 *
 * Read-only by construction: the repository exposes no update or delete for a transaction, the
 * Mongoose model rejects both in a pre-hook, and migration 0001 installs `RAISE(ABORT)` triggers
 * on the D1 table. There is no route that could reach one either. A mistaken entry is corrected
 * by a compensating adjustment, which leaves the correction visible.
 */
export async function history(
  actor: Actor,
  input: StockHistoryRequest,
): Promise<{ transactions: StockTransactionRecord[]; total: number }> {
  assertCanReadInventory(actor);

  return inventoryItemRepository.listHistory({
    organizationId: actor.organizationId,
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.experimentId ? { experimentId: input.experimentId } : {}),
    ...(input.issuedToUserId ? { issuedToUserId: input.issuedToUserId } : {}),
    ...(input.performedBy ? { performedBy: input.performedBy } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    page: input.page,
    pageSize: input.pageSize,
  });
}

export const stockService = {
  receive,
  issue,
  adjust,
  history,
  sweepExpired,
  sweepExpiredForActor,
};
