/**
 * Inventory items, their batches, and the append-only stock ledger.
 *
 * ── The batches need minted ids, and they must be deterministic ─────────────────────────
 *
 * `inventoryItemSchema.batches[]` is embedded with `{ _id: false }`, so MongoDB never gave a
 * batch an identity. D1's `inventory_batches` has a primary key and, more importantly,
 * `ux_inventory_batches` unique on (item, batch number) — which is the real identity and the one
 * the FEFO issue path looks a batch up by. The id is derived from exactly that pair, so a
 * re-run or a delta pass updates the same row rather than adding a second batch with the same
 * number and half the stock.
 *
 * ── The ledger is copied, never recomputed ──────────────────────────────────────────────
 *
 * `previous_quantity` and `new_quantity` on a stock transaction are what the database measured
 * at the time. A migration that recomputed a running total from the current quantity backwards
 * would produce a ledger that always balances — including across the gap where a correction was
 * made — which is precisely the property a stock audit exists to detect the absence of.
 */
import { InventoryItemModel, StockTransactionModel } from '@/server/db/models';
import {
  STOCK_ACTIONS,
  STOCK_ISSUE_TARGETS,
} from '@/server/db/models/stock-transaction.model';
import {
  INVENTORY_CATEGORIES,
  INVENTORY_ITEM_STATUSES,
  INVENTORY_UNITS,
  STOCK_STATES,
} from '@/server/domain/inventory';
import {
  derivedId,
  enumValue,
  iso,
  nullableEnum,
  nullableStr,
  num,
  oid,
  oidList,
  requiredIso,
  requiredOid,
  str,
} from '../convert';
import { deleteWhere, insert, insertImmutable, upsert } from '../sql';
import { modelStep } from '../step-helpers';
import type { MigrationStep, Statement } from '../types';
import { timestamps } from './identity';

export const inventoryItemsStep: MigrationStep = modelStep({
  name: 'inventory-items',
  description: 'Inventory items, batches and attached documents',
  targets: ['inventory_items', 'inventory_batches', 'inventory_item_documents'],
  requires: ['organizations', 'departments', 'users', 'files'],
  publishes: 'inventory_items',
  model: InventoryItemModel as never,
  withDeleted: true,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'inventory_items._id');
    const organizationId = requiredOid(document.organizationId, 'inventory_items.organizationId');
    const createdBy = requiredOid(document.createdBy, 'inventory_items.createdBy');

    const knownUsers = context.known.get('users');
    if (!knownUsers?.has(createdBy)) {
      return { kind: 'skip', reason: `creator ${createdBy} was not migrated` };
    }

    const departmentId = oid(document.departmentId);
    const updatedBy = oid(document.updatedBy);
    const knownFiles = context.known.get('files');

    const statements: Statement[] = [
      upsert('inventory_items', {
        id,
        organization_id: organizationId,
        department_id:
          departmentId && context.known.get('departments')?.has(departmentId) ? departmentId : null,
        name: str(document.name),
        code: str(document.code),
        category: enumValue(document.category, INVENTORY_CATEGORIES, INVENTORY_CATEGORIES[0]),
        unit: enumValue(document.unit, INVENTORY_UNITS, INVENTORY_UNITS[0]),
        description: str(document.description),
        // `ck_inventory_items_quantity` refuses a negative. A source row that is somehow
        // negative is a real data problem and must not be silently clamped to zero, which would
        // make the shelf and the record agree about a quantity neither of them has.
        available_quantity: num(document.availableQuantity),
        minimum_stock: num(document.minimumStock),
        stock_state: enumValue(document.stockState, STOCK_STATES, 'out_of_stock'),
        batch_number: str(document.batchNumber),
        expiry_date: iso(document.expiryDate),
        storage_location: str(document.storageLocation),
        supplier: str(document.supplier),
        status: enumValue(document.status, INVENTORY_ITEM_STATUSES, 'active'),
        created_by: createdBy,
        updated_by: updatedBy && knownUsers.has(updatedBy) ? updatedBy : null,
        ...timestamps(document),
        deleted_at: iso(document.deletedAt),
        deleted_by: oid(document.deletedBy),
      }),
      deleteWhere('inventory_batches', { item_id: id }),
      deleteWhere('inventory_item_documents', { item_id: id }),
    ];

    const batches = Array.isArray(document.batches) ? document.batches : [];
    const seenBatchNumbers = new Set<string>();
    for (const raw of batches) {
      const batch = raw as Record<string, unknown>;
      const batchNumber = str(batch.batchNumber);
      if (batchNumber.length === 0 || seenBatchNumbers.has(batchNumber)) continue;
      seenBatchNumbers.add(batchNumber);

      const receivedBy = oid(batch.receivedBy);
      statements.push(
        insert('inventory_batches', {
          id: derivedId('bat_', id, batchNumber),
          item_id: id,
          batch_number: batchNumber,
          quantity: num(batch.quantity),
          expiry_date: iso(batch.expiryDate),
          supplier: str(batch.supplier),
          storage_location: str(batch.storageLocation),
          received_at: requiredIso(
            batch.receivedAt,
            requiredIso(document.createdAt, new Date(0).toISOString()),
          ),
          received_by: receivedBy && knownUsers.has(receivedBy) ? receivedBy : null,
          // Not a foreign key in the schema, and left as the source recorded it: the receipt
          // transaction is in the ledger, which loads after items.
          receipt_transaction_id: oid(batch.receiptTransactionId),
          created_at: requiredIso(
            batch.receivedAt,
            requiredIso(document.createdAt, new Date(0).toISOString()),
          ),
        }),
      );
    }

    for (const fileId of new Set(oidList(document.documentFileIds))) {
      if (!knownFiles?.has(fileId)) continue;
      statements.push(insert('inventory_item_documents', { item_id: id, file_id: fileId }));
    }

    return { kind: 'write', statements };
  },
});

export const stockTransactionsStep: MigrationStep = modelStep({
  name: 'stock-transactions',
  description: 'The append-only stock ledger',
  targets: ['stock_transactions', 'stock_transaction_documents'],
  requires: ['inventory-items', 'users', 'files'],
  model: StockTransactionModel as never,
  deltaField: 'createdAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'stock_transactions._id');
    const organizationId = requiredOid(
      document.organizationId,
      'stock_transactions.organizationId',
    );
    const itemId = requiredOid(document.itemId, 'stock_transactions.itemId');

    if (!context.known.get('inventory_items')?.has(itemId)) {
      return { kind: 'skip', reason: `item ${itemId} was not migrated` };
    }

    const knownUsers = context.known.get('users');
    const knownFiles = context.known.get('files');
    const departmentId = oid(document.departmentId);
    const issuedToUserId = oid(document.issuedToUserId);
    const issuedToDepartmentId = oid(document.issuedToDepartmentId);
    const projectId = oid(document.projectId);
    const experimentId = oid(document.experimentId);
    const performedBy = oid(document.performedBy);
    const createdAt = requiredIso(document.createdAt, new Date(0).toISOString());

    const statements: Statement[] = [
      insertImmutable('stock_transactions', {
        id,
        organization_id: organizationId,
        item_id: itemId,
        // Denormalised at write time on both engines, so the ledger stays legible after an item
        // is renamed. Copied rather than re-read from the item for exactly that reason.
        item_code: str(document.itemCode),
        item_name: str(document.itemName),
        department_id:
          departmentId && context.known.get('departments')?.has(departmentId) ? departmentId : null,
        action: enumValue(document.action, STOCK_ACTIONS, 'adjusted'),
        quantity: num(document.quantity),
        quantity_delta: num(document.quantityDelta),
        previous_quantity: num(document.previousQuantity),
        new_quantity: num(document.newQuantity),
        unit: str(document.unit),
        batch_number: str(document.batchNumber),
        expiry_date: iso(document.expiryDate),
        supplier: str(document.supplier),
        storage_location: str(document.storageLocation),
        issued_to_type: nullableEnum(document.issuedToType, STOCK_ISSUE_TARGETS),
        issued_to_user_id:
          issuedToUserId && knownUsers?.has(issuedToUserId) ? issuedToUserId : null,
        issued_to_department_id:
          issuedToDepartmentId && context.known.get('departments')?.has(issuedToDepartmentId)
            ? issuedToDepartmentId
            : null,
        project_id: projectId && context.known.get('projects')?.has(projectId) ? projectId : null,
        experiment_id:
          experimentId && context.known.get('experiments')?.has(experimentId) ? experimentId : null,
        // The label survives even when the id does not, which is what keeps a historical issue
        // to a departed employee readable.
        issued_to_label: str(document.issuedToLabel),
        purpose: str(document.purpose),
        notes: str(document.notes),
        performed_by: performedBy && knownUsers?.has(performedBy) ? performedBy : null,
        performed_by_name: str(document.performedByName),
        performed_at: requiredIso(document.performedAt, createdAt),
        request_id: nullableStr(document.requestId),
        created_at: createdAt,
      }),
      deleteWhere('stock_transaction_documents', { transaction_id: id }),
    ];

    for (const fileId of new Set(oidList(document.documentFileIds))) {
      if (!knownFiles?.has(fileId)) continue;
      statements.push(insert('stock_transaction_documents', { transaction_id: id, file_id: fileId }));
    }

    return { kind: 'write', statements };
  },
});
