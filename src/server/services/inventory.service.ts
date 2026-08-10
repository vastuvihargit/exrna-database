/**
 * Inventory items — the definitions, not the stock.
 *
 * The line this service holds is the important one: **nothing here changes a quantity**.
 * `availableQuantity`, `batches`, `batchNumber` and `expiryDate` are not writable through
 * any input type in this file. Stock moves only through `stock.service.ts`, whose every path
 * writes a ledger row in the same transaction as the movement.
 *
 * That is now a structural guarantee rather than a convention. The repository used to take a
 * `Record<string, unknown>` update, so "no route reaches `availableQuantity`" was a fact about
 * the callers; `UpdateInventoryItemFields` is a closed set, so it is a fact about the type.
 *
 * Reading is organization-wide and needs only `inventory.view` (see
 * `inventoryVisibilityFilter` for why). Editing is scoped to the item's custodian
 * department by `assertInventoryPermission`.
 */
import { ConflictError, NotFoundError, ValidationError } from '@/server/errors/app-error';
import { sanitizeDisplayName } from '@/server/domain/naming';
import {
  expiryStateFor,
  type ExpiryState,
  type InventoryCategory,
  type InventoryItemStatus,
  type InventoryStockFilter,
  type InventoryUnit,
} from '@/server/domain/inventory';
import type { Actor } from '@/server/permissions/actor';
import { auditService } from '@/server/audit/audit.service';
import * as inventoryItemRepository from '@/server/repositories/inventory-item.repository';
import type {
  InventoryDashboard,
  InventoryItemRecord,
  UpdateInventoryItemFields,
} from '@/server/repositories/inventory-item.repository';
import * as departmentRepository from '@/server/repositories/department.repository';
import type { RequestMeta } from '@/server/http/request-meta';
import {
  assertCanReadInventory,
  assertInventoryPermission,
  capabilitiesFor,
  type InventoryCapabilities,
} from './inventory-access';

export interface InventoryItemView extends InventoryItemRecord {
  departmentName: string | null;
  /** Derived from `expiryDate` against the current time — never stored. */
  expiryState: ExpiryState;
  capabilities: InventoryCapabilities;
}

/* ------------------------------------------------------------------ reads */

export interface ListInventoryItemsInput {
  q?: string;
  category?: InventoryCategory;
  status?: InventoryItemStatus;
  departmentId?: string;
  supplier?: string;
  storageLocation?: string;
  stockFilter?: InventoryStockFilter;
  sort?: 'name' | 'code' | 'quantity' | 'expiry' | 'updated';
  order?: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export async function list(
  actor: Actor,
  input: ListInventoryItemsInput,
): Promise<{ items: InventoryItemView[]; total: number }> {
  assertCanReadInventory(actor);

  // One clock reading for the whole request: with two, an item could be counted as
  // near-expiry by the filter and rendered as expired by the view in the same response.
  const now = new Date();

  const { items, total } = await inventoryItemRepository.list({
    // Inventory has no per-item ACL — `inventory-access.ts` explains why — so the organization
    // *is* the visibility rule, and the contract makes it a required parameter rather than an
    // optional filter that a caller could omit into a cross-tenant listing.
    organizationId: actor.organizationId,
    ...(input.q ? { q: input.q } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.departmentId ? { departmentId: input.departmentId } : {}),
    ...(input.supplier ? { supplier: input.supplier } : {}),
    ...(input.storageLocation ? { storageLocation: input.storageLocation } : {}),
    ...(input.stockFilter ? { stockFilter: input.stockFilter } : {}),
    ...(input.sort ? { sort: input.sort } : {}),
    ...(input.order ? { order: input.order } : {}),
    now,
    page: input.page,
    pageSize: input.pageSize,
  });

  const departmentNames = await resolveDepartmentNames(items);
  return { items: items.map((item) => toView(actor, item, departmentNames, now)), total };
}

export async function getById(actor: Actor, itemId: string): Promise<InventoryItemView> {
  assertCanReadInventory(actor);

  const item = await inventoryItemRepository.findById(itemId);
  if (!item || item.organizationId !== actor.organizationId) throw new NotFoundError();

  const departmentNames = await resolveDepartmentNames([item]);
  return toView(actor, item, departmentNames, new Date());
}

/**
 * The counts behind the four dashboard tiles.
 *
 * One repository call rather than five: the tiles are read together on every page load, and
 * counting them separately lets a receipt land between two of them so the totals do not add up.
 */
export async function dashboard(actor: Actor): Promise<InventoryDashboard> {
  assertCanReadInventory(actor);
  return inventoryItemRepository.dashboard(actor.organizationId, new Date());
}

/**
 * Loads an item for a stock operation, or throws.
 *
 * Exported for the stock service (Phase 2) so that "find the item and check the actor may
 * touch it" is written once. Returns the raw record — the stock path works with quantities,
 * not with a view shaped for rendering.
 */
export async function resolveForStockChange(
  actor: Actor,
  itemId: string,
  permission: Parameters<typeof assertInventoryPermission>[1],
  message: string,
): Promise<InventoryItemRecord> {
  const item = await inventoryItemRepository.findById(itemId);
  if (!item || item.organizationId !== actor.organizationId) throw new NotFoundError();

  assertInventoryPermission(actor, permission, { departmentId: item.departmentId }, message);
  return item;
}

/* ---------------------------------------------------------------- mutate */

export interface CreateInventoryItemInput {
  name: string;
  code: string;
  category: InventoryCategory;
  unit: InventoryUnit;
  departmentId?: string | null;
  description?: string;
  minimumStock?: number;
  storageLocation?: string;
  supplier?: string;
  status?: InventoryItemStatus;
}

export async function create(
  actor: Actor,
  input: CreateInventoryItemInput,
  meta: RequestMeta,
): Promise<InventoryItemView> {
  const departmentId = await validDepartmentId(actor, input.departmentId ?? null);

  assertInventoryPermission(
    actor,
    'inventory.item.manage',
    { departmentId },
    departmentId
      ? 'You cannot add inventory items for this department'
      : 'Only a company-wide inventory administrator can add central store items',
  );

  const name = sanitizeDisplayName(input.name);
  if (!name) throw new ValidationError('Enter an item name');

  const code = input.code.trim().toUpperCase();
  if (await inventoryItemRepository.findByCode(actor.organizationId, code)) {
    throw new ConflictError(`An inventory item with the code "${code}" already exists`);
  }

  const item = await inventoryItemRepository.create({
    organizationId: actor.organizationId,
    departmentId,
    name,
    code,
    category: input.category,
    unit: input.unit,
    ...(input.description !== undefined ? { description: input.description } : {}),
    minimumStock: input.minimumStock ?? 0,
    ...(input.storageLocation !== undefined
      ? { storageLocation: input.storageLocation.trim() }
      : {}),
    ...(input.supplier !== undefined ? { supplier: input.supplier.trim() } : {}),
    status: input.status ?? 'active',
    createdBy: actor.userId,
  });

  await auditService.recordForActor(actor, meta, {
    action: 'inventory.item_created',
    entityType: 'inventory_item',
    entityId: item.id,
    entityLabel: `${item.code} — ${item.name}`,
    newValue: {
      code: item.code,
      name: item.name,
      category: item.category,
      unit: item.unit,
      departmentId: item.departmentId,
      minimumStock: item.minimumStock,
    },
    severity: 'notice',
  });

  const departmentNames = await resolveDepartmentNames([item]);
  return toView(actor, item, departmentNames, new Date());
}

/**
 * Edits the item definition.
 *
 * `code` is absent on purpose. It is printed on the shelf label and copied into every
 * historic transaction row; changing it would leave the ledger pointing at an identifier
 * that no longer exists anywhere physical. An item that was coded wrongly is deactivated
 * and replaced.
 *
 * Quantity fields are absent for the reason in the module header.
 */
export interface UpdateInventoryItemInput {
  name?: string;
  category?: InventoryCategory;
  unit?: InventoryUnit;
  departmentId?: string | null;
  description?: string;
  minimumStock?: number;
  storageLocation?: string;
  supplier?: string;
  status?: InventoryItemStatus;
}

export async function update(
  actor: Actor,
  itemId: string,
  input: UpdateInventoryItemInput,
  meta: RequestMeta,
): Promise<InventoryItemView> {
  const current = await inventoryItemRepository.findById(itemId);
  if (!current || current.organizationId !== actor.organizationId) throw new NotFoundError();

  assertInventoryPermission(
    actor,
    'inventory.item.manage',
    { departmentId: current.departmentId },
    'You cannot change this inventory item',
  );

  const update: UpdateInventoryItemFields = { updatedBy: actor.userId };

  if (input.name !== undefined) {
    const name = sanitizeDisplayName(input.name);
    if (!name) throw new ValidationError('Enter an item name');
    update.name = name;
  }
  if (input.category !== undefined) update.category = input.category;
  if (input.description !== undefined) update.description = input.description;
  if (input.storageLocation !== undefined) update.storageLocation = input.storageLocation.trim();
  if (input.supplier !== undefined) update.supplier = input.supplier.trim();
  if (input.status !== undefined) update.status = input.status;

  if (input.unit !== undefined && input.unit !== current.unit) {
    // Changing the unit does not convert anything: 5 L would silently become 5 mL, and the
    // history would still say litres. Empty the item first and the question disappears.
    if (current.availableQuantity > 0) {
      throw new ValidationError(
        'The unit cannot change while stock remains — issue or write off the remaining stock first',
      );
    }
    update.unit = input.unit;
  }

  if (input.minimumStock !== undefined) {
    update.minimumStock = input.minimumStock;
    // The reorder threshold is half of what `stockState` means, so moving it re-derives
    // the state in the same write. Otherwise raising the minimum would leave an item that
    // is now low still filed under "ok" until the next receipt.
    update.stockState =
      current.availableQuantity <= 0
        ? 'out_of_stock'
        : current.availableQuantity <= input.minimumStock
          ? 'low'
          : 'ok';
  }

  if (input.departmentId !== undefined) {
    const departmentId = await validDepartmentId(actor, input.departmentId);
    // Moving custody is itself a permission change: it must be allowed in both the old
    // department and the new one, or a department store manager could hand an item to
    // themselves — or away from the people accountable for it.
    assertInventoryPermission(
      actor,
      'inventory.item.manage',
      { departmentId },
      'You cannot move this item to that department',
    );
    update.departmentId = departmentId;
  }

  const updated = await inventoryItemRepository.update(itemId, update);
  if (!updated) throw new NotFoundError();

  await auditService.recordForActor(actor, meta, {
    action: 'inventory.item_updated',
    entityType: 'inventory_item',
    entityId: itemId,
    entityLabel: `${updated.code} — ${updated.name}`,
    previousValue: {
      name: current.name,
      category: current.category,
      unit: current.unit,
      minimumStock: current.minimumStock,
      status: current.status,
      departmentId: current.departmentId,
    },
    newValue: update,
  });

  const departmentNames = await resolveDepartmentNames([updated]);
  return toView(actor, updated, departmentNames, new Date());
}

/**
 * Retires an item.
 *
 * Refused while stock remains. Removing an item that is physically on a shelf would leave
 * material in the building with no record of it — the one outcome an inventory system
 * exists to prevent. Issue it or write it off first, and both of those leave a history row
 * explaining where it went.
 *
 * The transaction history survives regardless: it is a separate, append-only collection and
 * is not touched here.
 */
export async function deactivate(actor: Actor, itemId: string, meta: RequestMeta): Promise<void> {
  const current = await inventoryItemRepository.findById(itemId);
  if (!current || current.organizationId !== actor.organizationId) throw new NotFoundError();

  assertInventoryPermission(
    actor,
    'inventory.item.manage',
    { departmentId: current.departmentId },
    'You cannot remove this inventory item',
  );

  if (current.availableQuantity > 0) {
    throw new ValidationError(
      `${current.code} still holds ${current.availableQuantity} ${current.unit}. Issue or write off the remaining stock before removing it.`,
    );
  }

  await inventoryItemRepository.softDelete(itemId, actor.userId);

  await auditService.recordForActor(actor, meta, {
    action: 'inventory.item_deactivated',
    entityType: 'inventory_item',
    entityId: itemId,
    entityLabel: `${current.code} — ${current.name}`,
    severity: 'warning',
  });
}

/* --------------------------------------------------------------- helpers */

/**
 * Resolves the custodian department, or null for the central store.
 *
 * A department in another organization must be unreachable, not merely unusual: it would
 * put an item under a scope no grant in this organization can match, and nobody could ever
 * change it again.
 */
async function validDepartmentId(actor: Actor, departmentId: string | null): Promise<string | null> {
  if (!departmentId) return null;
  const department = await departmentRepository.findById(departmentId);
  if (!department || department.organizationId !== actor.organizationId) {
    throw new NotFoundError();
  }
  return department.id;
}

async function resolveDepartmentNames(
  items: InventoryItemRecord[],
): Promise<Map<string, string>> {
  const ids = [...new Set(items.map((item) => item.departmentId).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const departments = await departmentRepository.findByIds(ids);
  return new Map(departments.map((department) => [department.id, department.name]));
}

function toView(
  actor: Actor,
  item: InventoryItemRecord,
  departmentNames: Map<string, string>,
  now: Date,
): InventoryItemView {
  return {
    ...item,
    departmentName: item.departmentId ? (departmentNames.get(item.departmentId) ?? null) : null,
    // An item holding no stock has nothing that can expire, whatever date is left over on
    // the last consumed batch.
    expiryState: item.availableQuantity > 0 ? expiryStateFor(item.expiryDate, now) : 'none',
    capabilities: capabilitiesFor(actor, { departmentId: item.departmentId }),
  };
}

export const inventoryService = {
  list,
  getById,
  dashboard,
  create,
  update,
  deactivate,
  resolveForStockChange,
};
