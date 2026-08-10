/**
 * Inventory — the shape both engines implement.
 *
 * Two things make this contract different from the thirteen before it, and both come from the
 * same place: **this is the only module where a repository owns a physical invariant.** A file
 * that is listed twice is a bug; a shelf that reports 5 L when it holds 2 L is somebody
 * calculating a dose from a number that is not true.
 *
 * ── 1. The contract is stock *operations*, not batch rows ───────────────────────────────
 *
 * The obvious contract — `addBatch`, `decrementBatch`, `updateSummary` — would let a service
 * decrement a batch and then fail before writing the ledger row, and the material would be gone
 * from the system with no record of where it went. So the unit of work here is the operation a
 * store manager actually performs: `receive`, `issue`, `adjust`, `expire`. Each one moves stock
 * **and** appends its ledger row, or does neither.
 *
 * That also means neither engine can be "the simple one that skips the transaction". There is no
 * signature through which a caller could forget.
 *
 * ── 2. Negative stock is prevented by the engine, not by the service ────────────────────
 *
 * A check-then-decrement in application code has a window, and the window is exactly the case
 * that matters: two people issuing the last of a reagent at the same moment. Both read 5, both
 * decide 3 is fine, and the shelf owes 1.
 *
 * MongoDB closed that window with a `findOneAndUpdate` whose filter carried the availability
 * condition, so a losing racer matched no document. D1 has no interactive transaction, so it
 * closes the same window differently: every decrement runs inside one `batch()`, and
 * `CHECK (quantity >= 0)` aborts the whole batch if any of them would overdraw. Both engines
 * therefore fail the *second* request rather than serving it — see `InsufficientStockError`.
 *
 * ── 3. `previousQuantity` / `newQuantity` are computed by the database ──────────────────
 *
 * This is subtle and was worth the extra SQL. Those two columns are what an auditor reads to
 * confirm the counter never drifted, so computing them in JavaScript from a value read a moment
 * earlier defeats their purpose: two concurrent issues of 3 from a stock of 10 would both record
 * "10 → 7" while the item correctly reached 4. The numbers would look self-consistent and be
 * wrong, which is worse than an obvious error.
 *
 * Both implementations therefore derive them from the row *after* the decrement — a subquery on
 * D1, the returned document under a session on MongoDB.
 */
import type { ClientSession } from 'mongoose';
import type {
  InventoryCategory,
  InventoryItemStatus,
  InventoryStockFilter,
  InventoryUnit,
  StockState,
} from '@/server/domain/inventory';
import type { StockAction, StockIssueTarget } from '@/server/db/models/stock-transaction.model';

/** A Mongoose session on the Mongo path; ignored on D1, which has no interactive transaction. */
export type InventoryTx = ClientSession;

export interface InventoryBatchRecord {
  /** Absent on MongoDB, where a batch is an embedded subdocument keyed by its number. */
  id: string | null;
  batchNumber: string;
  quantity: number;
  expiryDate: Date | null;
  supplier: string;
  storageLocation: string;
  receivedAt: Date;
  receivedBy: string | null;
  receiptTransactionId: string | null;
}

export interface InventoryItemRecord {
  id: string;
  organizationId: string;
  departmentId: string | null;
  name: string;
  code: string;
  category: InventoryCategory;
  unit: InventoryUnit;
  description: string;
  availableQuantity: number;
  minimumStock: number;
  stockState: StockState;
  batches: InventoryBatchRecord[];
  batchNumber: string;
  expiryDate: Date | null;
  storageLocation: string;
  supplier: string;
  status: InventoryItemStatus;
  documentFileIds: string[];
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StockTransactionRecord {
  id: string;
  organizationId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  departmentId: string | null;
  action: StockAction;
  quantity: number;
  quantityDelta: number;
  previousQuantity: number;
  newQuantity: number;
  unit: string;
  batchNumber: string;
  expiryDate: Date | null;
  supplier: string;
  storageLocation: string;
  issuedToType: StockIssueTarget | null;
  issuedToUserId: string | null;
  issuedToDepartmentId: string | null;
  projectId: string | null;
  experimentId: string | null;
  issuedToLabel: string;
  purpose: string;
  notes: string;
  performedBy: string | null;
  performedByName: string;
  performedAt: Date;
  requestId: string | null;
  createdAt: Date;
}

/* ------------------------------------------------------------------ reads */

export interface ListInventoryItemsInput {
  /**
   * Every query is narrowed to one organization, and the parameter is required rather than
   * optional so that a caller cannot produce a cross-tenant listing by omitting it. Inventory
   * has no per-item ACL — `inventory-access.ts` explains why — so this *is* the visibility rule.
   */
  organizationId: string;
  q?: string;
  category?: InventoryCategory;
  status?: InventoryItemStatus;
  departmentId?: string;
  supplier?: string;
  storageLocation?: string;
  stockFilter?: InventoryStockFilter;
  /** Injected rather than read from the clock so expiry filters are testable. */
  now: Date;
  page: number;
  pageSize: number;
  sort?: 'name' | 'code' | 'quantity' | 'expiry' | 'updated';
  order?: 'asc' | 'desc';
}

export interface ListStockHistoryInput {
  organizationId: string;
  itemId?: string;
  action?: StockAction;
  projectId?: string;
  experimentId?: string;
  issuedToUserId?: string;
  performedBy?: string;
  /** Inclusive lower and exclusive upper bound on `performedAt`. */
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

/** What the dashboard renders, in one round trip per engine. */
export interface InventoryDashboard {
  totalItems: number;
  byStockState: Record<StockState, number>;
  nearExpiry: number;
  expired: number;
}

/* ------------------------------------------------------------------ writes */

export interface CreateInventoryItemInput {
  organizationId: string;
  departmentId: string | null;
  name: string;
  code: string;
  category: InventoryCategory;
  unit: InventoryUnit;
  description?: string;
  minimumStock: number;
  storageLocation?: string;
  supplier?: string;
  status: InventoryItemStatus;
  documentFileIds?: string[];
  createdBy: string;
}

/**
 * The fields an item edit may change.
 *
 * A closed set rather than `Record<string, unknown>`, which is what the Mongo repository took
 * before this module: that signature let any caller reach `availableQuantity`, and the promise
 * that stock only moves through the ledger was a convention rather than a type. `code` is absent
 * for the reason `inventory.service.ts` gives — it is printed on the shelf label.
 */
export interface UpdateInventoryItemFields {
  name?: string;
  category?: InventoryCategory;
  unit?: InventoryUnit;
  departmentId?: string | null;
  description?: string;
  minimumStock?: number;
  /** Recomputed by the service whenever `minimumStock` moves; never set on its own. */
  stockState?: StockState;
  storageLocation?: string;
  supplier?: string;
  status?: InventoryItemStatus;
  documentFileIds?: string[];
  updatedBy: string;
}

/** Everything the ledger row needs that the item does not already supply. */
export interface StockContext {
  performedBy: string | null;
  performedByName: string;
  performedAt: Date;
  purpose?: string;
  notes?: string;
  requestId?: string | null;
  documentFileIds?: string[];
}

export interface ReceiveStockInput extends StockContext {
  itemId: string;
  quantity: number;
  batchNumber: string;
  expiryDate: Date | null;
  supplier?: string;
  storageLocation?: string;
}

export interface IssueTarget {
  type: StockIssueTarget;
  userId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  experimentId?: string | null;
  /** Denormalized so history reads without four lookups. */
  label: string;
}

export interface IssueStockInput extends StockContext {
  itemId: string;
  quantity: number;
  target: IssueTarget;
  /**
   * Which batches to draw from and how much from each, in issue order.
   *
   * Chosen by the service using `planIssue`, not by the repository, because the choice is a
   * business rule (first-expiry-first-out, never an expired batch) and both engines must make
   * exactly the same one. The repository's job is to apply the plan atomically or not at all.
   */
  allocations: BatchAllocation[];
}

export interface BatchAllocation {
  batchNumber: string;
  quantity: number;
  expiryDate: Date | null;
}

/**
 * A correction, and the only operation that may move stock without a physical movement.
 *
 * `delta` is signed. A negative adjustment names the batch it comes out of; a positive one
 * names the batch it goes into, creating it if the batch number is new — a recount that finds
 * more than the system knew about is a real outcome, not an error.
 */
export interface AdjustStockInput extends StockContext {
  itemId: string;
  batchNumber: string;
  delta: number;
  expiryDate?: Date | null;
  reason: string;
}

/**
 * Writes off everything that has passed its expiry date.
 *
 * A sweep rather than a per-item call, because it runs unattended and the alternative — the UI
 * hiding expired stock while the counter still includes it — is how a quantity on screen stops
 * matching the shelf.
 */
export interface ExpireStockInput {
  organizationId: string;
  now: Date;
  performedBy?: string | null;
  performedByName?: string;
}

export interface StockResult {
  item: InventoryItemRecord;
  transaction: StockTransactionRecord;
}

export interface InventoryRepository {
  findById(id: string): Promise<InventoryItemRecord | null>;
  findByCode(organizationId: string, code: string): Promise<InventoryItemRecord | null>;
  list(input: ListInventoryItemsInput): Promise<{ items: InventoryItemRecord[]; total: number }>;
  dashboard(organizationId: string, now: Date): Promise<InventoryDashboard>;

  create(input: CreateInventoryItemInput, tx?: InventoryTx): Promise<InventoryItemRecord>;
  update(
    id: string,
    fields: UpdateInventoryItemFields,
    tx?: InventoryTx,
  ): Promise<InventoryItemRecord | null>;
  softDelete(id: string, deletedBy: string): Promise<boolean>;

  receive(input: ReceiveStockInput): Promise<StockResult>;
  issue(input: IssueStockInput): Promise<StockResult>;
  adjust(input: AdjustStockInput): Promise<StockResult>;
  expire(input: ExpireStockInput): Promise<StockTransactionRecord[]>;

  listHistory(
    input: ListStockHistoryInput,
  ): Promise<{ transactions: StockTransactionRecord[]; total: number }>;
  findTransactionById(id: string): Promise<StockTransactionRecord | null>;
}

/* ------------------------------------------------------------------ shared domain errors */

/**
 * Raised when a decrement would overdraw, by either engine.
 *
 * A distinct class rather than a `ValidationError` because the two are handled differently: this
 * one is reachable *after* validation passed, when somebody else got there first, and the caller
 * may legitimately re-read and offer the smaller number. The HTTP mapping is 409, not 400.
 */
export class InsufficientStockError extends Error {
  readonly available: number;
  readonly requested: number;

  constructor(available: number, requested: number, unit: string) {
    super(
      `Only ${available} ${unit} remain in issuable batches — ${requested} ${unit} were requested. ` +
        'Somebody may have issued stock while this form was open; reload and try again.',
    );
    this.name = 'InsufficientStockError';
    this.available = available;
    this.requested = requested;
  }
}

/** Raised when the requested batch does not exist on the item, or holds nothing. */
export class UnknownBatchError extends Error {
  constructor(batchNumber: string) {
    super(`Batch "${batchNumber}" does not exist on this item`);
    this.name = 'UnknownBatchError';
  }
}

/**
 * Raised when an issue names a batch that has expired.
 *
 * Separate from `InsufficientStockError` because the remedy is different: there is stock, and
 * the answer is not "try a smaller number" but "that material must be written off". Expired
 * stock is never silently skipped — see `planIssue`.
 */
export class ExpiredBatchError extends Error {
  constructor(batchNumber: string) {
    super(
      `Batch "${batchNumber}" has passed its expiry date and cannot be issued. ` +
        'Write it off with a stock adjustment instead.',
    );
    this.name = 'ExpiredBatchError';
  }
}
