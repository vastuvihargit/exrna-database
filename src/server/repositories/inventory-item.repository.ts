/**
 * Inventory — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_INVENTORY`, which covers items, batches *and* the stock ledger. They
 * are one flag rather than three because they are one transaction: an issue decrements a batch
 * and appends a ledger row atomically, and there is no engine in which half of that can live
 * somewhere else.
 *
 * `DATA_SOURCE_DEPENDENCIES` already records that this module needs organizations, users and
 * departments on D1 — the item's `organization_id`, `created_by` and `department_id` are real
 * foreign keys there. The ledger adds `projects` and `experiments` for the same reason, so the
 * dependency list is extended in `data-source.ts` alongside this file.
 */
import { isD1 } from './data-source';
import { mongoInventoryRepository } from './inventory-item.repository.mongo';
import { d1InventoryRepository } from './inventory-item.repository.d1';
import type {
  AdjustStockInput,
  CreateInventoryItemInput,
  ExpireStockInput,
  InventoryBatchRecord,
  InventoryDashboard,
  InventoryItemRecord,
  InventoryRepository,
  InventoryTx,
  IssueStockInput,
  ListInventoryItemsInput,
  ListStockHistoryInput,
  ReceiveStockInput,
  StockResult,
  StockTransactionRecord,
  UpdateInventoryItemFields,
} from './inventory-item.repository.contract';

export type {
  AdjustStockInput,
  CreateInventoryItemInput,
  ExpireStockInput,
  InventoryBatchRecord,
  InventoryDashboard,
  InventoryItemRecord,
  InventoryRepository,
  InventoryTx,
  IssueStockInput,
  ListInventoryItemsInput,
  ListStockHistoryInput,
  ReceiveStockInput,
  StockResult,
  StockTransactionRecord,
  UpdateInventoryItemFields,
};
export {
  ExpiredBatchError,
  InsufficientStockError,
  UnknownBatchError,
} from './inventory-item.repository.contract';
export { mongoInventoryRepository, d1InventoryRepository };

function active(): InventoryRepository {
  return isD1('inventory') ? d1InventoryRepository : mongoInventoryRepository;
}

export function findById(id: string): Promise<InventoryItemRecord | null> {
  return active().findById(id);
}

export function findByCode(
  organizationId: string,
  code: string,
): Promise<InventoryItemRecord | null> {
  return active().findByCode(organizationId, code);
}

export function list(
  input: ListInventoryItemsInput,
): Promise<{ items: InventoryItemRecord[]; total: number }> {
  return active().list(input);
}

export function dashboard(organizationId: string, now: Date): Promise<InventoryDashboard> {
  return active().dashboard(organizationId, now);
}

export function create(
  input: CreateInventoryItemInput,
  tx?: InventoryTx,
): Promise<InventoryItemRecord> {
  return active().create(input, tx);
}

export function update(
  id: string,
  fields: UpdateInventoryItemFields,
  tx?: InventoryTx,
): Promise<InventoryItemRecord | null> {
  return active().update(id, fields, tx);
}

export function softDelete(id: string, deletedBy: string): Promise<boolean> {
  return active().softDelete(id, deletedBy);
}

export function receive(input: ReceiveStockInput): Promise<StockResult> {
  return active().receive(input);
}

export function issue(input: IssueStockInput): Promise<StockResult> {
  return active().issue(input);
}

export function adjust(input: AdjustStockInput): Promise<StockResult> {
  return active().adjust(input);
}

export function expire(input: ExpireStockInput): Promise<StockTransactionRecord[]> {
  return active().expire(input);
}

export function listHistory(
  input: ListStockHistoryInput,
): Promise<{ transactions: StockTransactionRecord[]; total: number }> {
  return active().listHistory(input);
}

export function findTransactionById(id: string): Promise<StockTransactionRecord | null> {
  return active().findTransactionById(id);
}
