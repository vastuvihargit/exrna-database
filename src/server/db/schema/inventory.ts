/**
 * Inventory items, batches and the append-only stock ledger.
 *
 * ── The one place where normalization changes an atomicity guarantee ────────────────────
 *
 * MongoDB embedded `batches[]` inside the item so that the availability check and the
 * decrement were a single atomic `findOneAndUpdate` — the filter carried
 * `quantity: { $gte: n }`, so a concurrent issue that would overdraw simply matched nothing.
 * There was no read-then-write window.
 *
 * D1 has no interactive transactions, so that property has to be re-established rather than
 * inherited. It is, and by the same mechanism: the decrement is a conditional UPDATE.
 *
 *     UPDATE inventory_batches
 *        SET quantity = quantity - ?
 *      WHERE id = ? AND quantity >= ?
 *
 * If two requests race, SQLite serializes them and the second sees the decremented value, so
 * exactly one `changes()` comes back as 1. **Negative stock is prevented by the WHERE clause,
 * not by a transaction** — which is what makes the guarantee survive the move.
 *
 * `CHECK (quantity >= 0)` below is the belt to that braces: even a hand-written statement
 * during an incident cannot drive a batch negative.
 */
import { check, index, sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import {
  INVENTORY_CATEGORIES,
  INVENTORY_ITEM_STATUSES,
  INVENTORY_UNITS,
  STOCK_STATES,
} from '@/server/domain/inventory';
import { STOCK_ACTIONS, STOCK_ISSUE_TARGETS } from '@/server/db/models/stock-transaction.model';
import { createdAtColumn, enumText, softDeleteColumns, timestampColumns } from './_shared';
import { departments, organizations, users } from './identity';
import { experiments, projects } from './research';
import { files } from './drive';

/* ------------------------------------------------------------------ inventory_items */

export const inventoryItems = sqliteTable(
  'inventory_items',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    /** The custodian department. Null means a central store. */
    departmentId: text('department_id').references(() => departments.id),

    name: text('name').notNull(),
    /** Human-facing identifier printed on the shelf label, e.g. `CHM-0042`. */
    code: text('code').notNull(),
    category: enumText('category', INVENTORY_CATEGORIES).notNull(),
    unit: enumText('unit', INVENTORY_UNITS).notNull(),
    description: text('description').notNull().default(''),

    /**
     * Derived from `inventory_batches`, never written directly by a route.
     *
     * Kept as a stored column rather than computed on read for exactly the reason it existed
     * in MongoDB: listing, filtering and low-stock alerting need it in an index.
     */
    availableQuantity: integer('available_quantity').notNull().default(0),
    minimumStock: integer('minimum_stock').notNull().default(0),
    stockState: enumText('stock_state', STOCK_STATES).notNull().default('out_of_stock'),

    /** Derived: the batch that should be issued next (first expiry first out). */
    batchNumber: text('batch_number').notNull().default(''),
    /** Derived: the earliest expiry among batches that still hold stock. */
    expiryDate: text('expiry_date'),

    /** Defaults offered when receiving stock; a receipt may override either. */
    storageLocation: text('storage_location').notNull().default(''),
    supplier: text('supplier').notNull().default(''),

    status: enumText('status', INVENTORY_ITEM_STATUSES).notNull().default('active'),

    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    updatedBy: text('updated_by').references(() => users.id),
    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    /**
     * Codes are unique per organization and permanent — deliberately surviving a soft
     * delete, because the code is printed on the shelf and quoted in every historic ledger
     * row. Reusing it for a different material would make the history ambiguous.
     */
    uniqueIndex('ux_inventory_items_org_code').on(table.organizationId, table.code),
    index('ix_inventory_items_status_category').on(
      table.organizationId,
      table.status,
      table.category,
    ),
    index('ix_inventory_items_department').on(
      table.organizationId,
      table.departmentId,
      table.status,
    ),
    index('ix_inventory_items_stock_state').on(table.organizationId, table.stockState),
    index('ix_inventory_items_expiry').on(table.organizationId, table.expiryDate),
    index('ix_inventory_items_name').on(table.organizationId, table.name),
    check('ck_inventory_items_quantity', sql`available_quantity >= 0`),
  ],
);

/* ------------------------------------------------------------------ inventory_batches */

/**
 * `inventoryItems.batches[]`.
 *
 * A child table now, not because embedding was wrong, but because SQL gives no way to
 * conditionally decrement one element of a JSON array atomically. Per-batch rows make the
 * conditional UPDATE described at the top of this file possible.
 *
 * "Expired stock must not be issued" is why per-batch quantities exist at all: 500 g in stock
 * says nothing about how much of it expired last week.
 */
export const inventoryBatches = sqliteTable(
  'inventory_batches',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => inventoryItems.id, { onDelete: 'cascade' }),

    /** As printed on the container label. */
    batchNumber: text('batch_number').notNull(),
    quantity: integer('quantity').notNull(),
    expiryDate: text('expiry_date'),
    supplier: text('supplier').notNull().default(''),
    storageLocation: text('storage_location').notNull().default(''),

    receivedAt: text('received_at').notNull(),
    receivedBy: text('received_by').references(() => users.id),
    /** The receipt that created this batch, so the item view can link back to it. */
    receiptTransactionId: text('receipt_transaction_id'),

    ...createdAtColumn,
  },
  (table) => [
    /** One row per batch number within an item — the shelf label is the identity. */
    uniqueIndex('ux_inventory_batches').on(table.itemId, table.batchNumber),
    /** First-expiry-first-out: the issuing order, and the near-expiry sweep. */
    index('ix_inventory_batches_fefo').on(table.itemId, table.expiryDate),
    index('ix_inventory_batches_expiry').on(table.expiryDate),
    check('ck_inventory_batches_quantity', sql`quantity >= 0`),
  ],
);

/** `inventoryItems.documentFileIds[]` — certificates of analysis, safety data sheets. */
export const inventoryItemDocuments = sqliteTable(
  'inventory_item_documents',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => inventoryItems.id, { onDelete: 'cascade' }),
    /**
     * A row in `files`. Inventory stores no bytes of its own and never touches the storage
     * layer; resolving one goes through the file service so its permissions apply unchanged.
     */
    fileId: text('file_id')
      .notNull()
      .references(() => files.id),
  },
  (table) => [uniqueIndex('ux_inventory_item_documents').on(table.itemId, table.fileId)],
);

/* ------------------------------------------------------------------ stock_transactions */

/**
 * The stock ledger — every movement of every item, and the stock history the UI reads.
 *
 * Append-only. In MongoDB that was enforced in three layers: a repository exposing only
 * append and query, pre-hooks rejecting every update and delete, and no route that could
 * reach one.
 *
 * Layer 2 has no direct SQL equivalent — SQLite has no per-table "reject UPDATE" switch short
 * of a trigger. **Two `RAISE(ABORT)` triggers are therefore created in migration 0001**, so
 * immutability stays a property of the data rather than of the code that happens to be
 * calling. A future service that tries to "fix" a row fails loudly instead of quietly
 * rewriting history.
 *
 * There are deliberately no soft-delete columns: nothing here may be removed. A mistaken
 * entry is corrected by a compensating `adjusted` row, which is how a stock ledger works and
 * leaves the correction visible.
 */
export const stockTransactions = sqliteTable(
  'stock_transactions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    itemId: text('item_id')
      .notNull()
      .references(() => inventoryItems.id),
    /** Denormalized so history renders without a join, and survives the item being renamed. */
    itemCode: text('item_code').notNull(),
    itemName: text('item_name').notNull(),
    departmentId: text('department_id').references(() => departments.id),

    action: enumText('action', STOCK_ACTIONS).notNull(),
    /** The magnitude as entered by the user, always positive. */
    quantity: integer('quantity').notNull(),
    /** Signed: + for added/returned, − for issued/expired, either for adjusted. */
    quantityDelta: integer('quantity_delta').notNull(),
    /**
     * Recorded rather than recomputed by replaying the ledger. These are what make a single
     * row self-explanatory to an auditor, and the check that the item's counter never drifted.
     */
    previousQuantity: integer('previous_quantity').notNull(),
    newQuantity: integer('new_quantity').notNull(),
    unit: text('unit').notNull(),

    batchNumber: text('batch_number').notNull().default(''),
    expiryDate: text('expiry_date'),
    supplier: text('supplier').notNull().default(''),
    storageLocation: text('storage_location').notNull().default(''),

    issuedToType: enumText('issued_to_type', STOCK_ISSUE_TARGETS),
    issuedToUserId: text('issued_to_user_id').references(() => users.id),
    issuedToDepartmentId: text('issued_to_department_id').references(() => departments.id),
    projectId: text('project_id').references(() => projects.id),
    experimentId: text('experiment_id').references(() => experiments.id),
    /** Denormalized label of the issue target, so history reads without four lookups. */
    issuedToLabel: text('issued_to_label').notNull().default(''),

    purpose: text('purpose').notNull().default(''),
    notes: text('notes').notNull().default(''),

    /** The person who received, issued or adjusted. Null only for the expiry sweep. */
    performedBy: text('performed_by').references(() => users.id),
    performedByName: text('performed_by_name').notNull().default(''),
    /** The received / issue date, which may be backdated by the user. */
    performedAt: text('performed_at').notNull(),
    /** Ties this row to its audit-log entry and to the request that produced it. */
    requestId: text('request_id'),

    ...createdAtColumn,
  },
  (table) => [
    index('ix_stock_transactions_org').on(table.organizationId, table.createdAt),
    index('ix_stock_transactions_item').on(table.itemId, table.createdAt),
    index('ix_stock_transactions_action').on(table.organizationId, table.action, table.createdAt),
    index('ix_stock_transactions_performer').on(table.performedBy, table.createdAt),
    index('ix_stock_transactions_project').on(table.projectId, table.createdAt),
    index('ix_stock_transactions_experiment').on(table.experimentId, table.createdAt),
    index('ix_stock_transactions_issued_to').on(table.issuedToUserId, table.createdAt),
    index('ix_stock_transactions_batch').on(table.organizationId, table.batchNumber),
    check('ck_stock_transactions_quantity', sql`quantity >= 0`),
    check('ck_stock_transactions_new_quantity', sql`new_quantity >= 0`),
  ],
);

/** `stockTransactions.documentFileIds[]` — delivery notes and certificates. */
export const stockTransactionDocuments = sqliteTable(
  'stock_transaction_documents',
  {
    transactionId: text('transaction_id')
      .notNull()
      .references(() => stockTransactions.id, { onDelete: 'cascade' }),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id),
  },
  (table) => [uniqueIndex('ux_stock_transaction_documents').on(table.transactionId, table.fileId)],
);
