/**
 * The D1 inventory repository — items, batches and the stock ledger.
 *
 * ── Every stock operation is exactly one `batch()` ──────────────────────────────────────
 *
 * D1 has no interactive transaction, but `batch()` *is* a transaction: the whole list commits or
 * none of it does. That is enough here, because a stock operation never needs to branch on what
 * it just read — the decision (which batches, how much from each) is made by `planIssue` before
 * the first statement, and the engine's job is to apply it or refuse.
 *
 * ── Negative stock is prevented by CHECK, and that is the whole mechanism ───────────────
 *
 * There is no read-then-write window to close because nothing is read between the statements.
 * Each decrement is unconditional arithmetic:
 *
 *     UPDATE inventory_batches SET quantity = quantity - ? WHERE item_id = ? AND batch_number = ?
 *
 * and `CHECK (quantity >= 0)` aborts it if it would overdraw. An abort inside `batch()` rolls
 * the entire operation back, including the ledger row — so the losing racer gets an error and
 * the shelf is never short. `translateConstraint` turns that engine error into
 * `InsufficientStockError`, which the route maps to 409.
 *
 * A conditional `WHERE quantity >= ?` would *also* prevent the overdraw, but silently: the
 * statement would affect no rows, the ledger row would still be inserted, and the system would
 * record an issue that never happened. Failing loudly is the point.
 *
 * ── Zero-quantity batch rows are kept, where MongoDB prunes them ────────────────────────
 *
 * This is the one deliberate divergence between the engines, and it is what makes the paragraph
 * above sound. MongoDB prunes consumed batches because they live in an embedded array that has
 * to stay bounded (`MAX_BATCHES_PER_ITEM`). A D1 batch is a row, and rows are cheap.
 *
 * Keeping them matters: if a concurrent issue could *delete* a row this operation is about to
 * decrement, the decrement would find nothing, affect zero rows, raise no CHECK — and the ledger
 * would over-report. With the row always present, the CHECK is the only outcome. The record
 * returned to callers still hides empty batches, because an empty container is not stock.
 *
 * ── The ledger's before/after figures are computed by the database ──────────────────────
 *
 * `previous_quantity` and `new_quantity` are what an auditor reads to confirm the counter never
 * drifted, so they are derived in the INSERT from the item row *after* the decrement rather than
 * from a value read beforehand. Two concurrent issues of 3 from a stock of 10 would otherwise
 * both record "10 → 7" while the item correctly reached 4 — self-consistent and wrong.
 */
import { and, eq, gt, isNotNull, lt, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getD1 } from '@/server/db/d1-context';
import type { Database } from '@/server/db/d1';
import {
  inventoryBatches,
  inventoryItems,
  stockTransactions,
} from '@/server/db/schema/inventory';
import {
  nearExpiryCutoff,
  type InventoryCategory,
  type InventoryItemStatus,
  type InventoryUnit,
  type StockState,
} from '@/server/domain/inventory';
import type { StockAction, StockIssueTarget } from '@/server/db/models/stock-transaction.model';
import {
  InsufficientStockError,
  UnknownBatchError,
  type AdjustStockInput,
  type CreateInventoryItemInput,
  type ExpireStockInput,
  type InventoryBatchRecord,
  type InventoryDashboard,
  type InventoryItemRecord,
  type InventoryRepository,
  type IssueStockInput,
  type ListInventoryItemsInput,
  type ListStockHistoryInput,
  type ReceiveStockInput,
  type StockContext,
  type StockResult,
  type StockTransactionRecord,
  type UpdateInventoryItemFields,
} from './inventory-item.repository.contract';

/* ------------------------------------------------------------------ row shapes */

interface ItemRow {
  id: string;
  organization_id: string;
  department_id: string | null;
  name: string;
  code: string;
  category: string;
  unit: string;
  description: string;
  available_quantity: number;
  minimum_stock: number;
  stock_state: string;
  batch_number: string;
  expiry_date: string | null;
  storage_location: string;
  supplier: string;
  status: string;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

interface BatchRow {
  id: string;
  item_id: string;
  batch_number: string;
  quantity: number;
  expiry_date: string | null;
  supplier: string;
  storage_location: string;
  received_at: string;
  received_by: string | null;
  receipt_transaction_id: string | null;
}

interface TransactionRow {
  id: string;
  organization_id: string;
  item_id: string;
  item_code: string;
  item_name: string;
  department_id: string | null;
  action: string;
  quantity: number;
  quantity_delta: number;
  previous_quantity: number;
  new_quantity: number;
  unit: string;
  batch_number: string;
  expiry_date: string | null;
  supplier: string;
  storage_location: string;
  issued_to_type: string | null;
  issued_to_user_id: string | null;
  issued_to_department_id: string | null;
  project_id: string | null;
  experiment_id: string | null;
  issued_to_label: string;
  purpose: string;
  notes: string;
  performed_by: string | null;
  performed_by_name: string;
  performed_at: string;
  request_id: string | null;
  created_at: string;
}

/**
 * `crypto.randomUUID()`, as every other D1 repository does.
 *
 * Nothing in D1 requires the BSON shape, and the ids that *must* keep it are the migrated ones —
 * which arrive from MongoDB already formed and are inserted verbatim, never minted here.
 */
function newId(): string {
  return crypto.randomUUID();
}

function date(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toBatchRecord(row: BatchRow): InventoryBatchRecord {
  return {
    id: row.id,
    batchNumber: row.batch_number,
    quantity: row.quantity,
    expiryDate: date(row.expiry_date),
    supplier: row.supplier,
    storageLocation: row.storage_location,
    receivedAt: new Date(row.received_at),
    receivedBy: row.received_by,
    receiptTransactionId: row.receipt_transaction_id,
  };
}

function toRecord(row: ItemRow, batches: BatchRow[]): InventoryItemRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    departmentId: row.department_id,
    name: row.name,
    code: row.code,
    category: row.category as InventoryCategory,
    unit: row.unit as InventoryUnit,
    description: row.description,
    availableQuantity: row.available_quantity,
    minimumStock: row.minimum_stock,
    stockState: row.stock_state as StockState,
    // Empty rows are kept in the table (see the header) but are not stock, so they are not
    // reported as batches. This is what keeps the record shape identical to MongoDB's.
    batches: batches.filter((batch) => batch.quantity > 0).map(toBatchRecord),
    batchNumber: row.batch_number,
    expiryDate: date(row.expiry_date),
    storageLocation: row.storage_location,
    supplier: row.supplier,
    status: row.status as InventoryItemStatus,
    documentFileIds: [],
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function toTransactionRecord(row: TransactionRow): StockTransactionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    departmentId: row.department_id,
    action: row.action as StockAction,
    quantity: row.quantity,
    quantityDelta: row.quantity_delta,
    previousQuantity: row.previous_quantity,
    newQuantity: row.new_quantity,
    unit: row.unit,
    batchNumber: row.batch_number,
    expiryDate: date(row.expiry_date),
    supplier: row.supplier,
    storageLocation: row.storage_location,
    issuedToType: (row.issued_to_type as StockIssueTarget | null) ?? null,
    issuedToUserId: row.issued_to_user_id,
    issuedToDepartmentId: row.issued_to_department_id,
    projectId: row.project_id,
    experimentId: row.experiment_id,
    issuedToLabel: row.issued_to_label,
    purpose: row.purpose,
    notes: row.notes,
    performedBy: row.performed_by,
    performedByName: row.performed_by_name,
    performedAt: new Date(row.performed_at),
    requestId: row.request_id,
    createdAt: new Date(row.created_at),
  };
}

/**
 * Turns the engine's constraint violation into the domain error the route knows how to map.
 *
 * Matching on the *named* constraints rather than on the word "CHECK": an unrelated constraint
 * failure reported as "insufficient stock" would send an operator looking at the wrong shelf.
 * Anything unrecognised is rethrown unchanged.
 */
function translateConstraint(error: unknown, unit: string, requested: number): never {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes('ck_inventory_batches_quantity') ||
    message.includes('ck_inventory_items_quantity') ||
    message.includes('ck_stock_transactions_new_quantity')
  ) {
    // The available figure is not reported here because the read that produced it is exactly
    // the one that went stale. `-1` would be a lie; the message tells the user to reload.
    throw new InsufficientStockError(0, requested, unit);
  }
  throw error;
}

/* ------------------------------------------------------------------ shared SQL fragments */

/**
 * Recomputes the four derived summary columns from the batch table.
 *
 * The ordering rule is the same first-expiry-first-out that `planIssue` uses, expressed in SQL:
 * `expiry_date IS NULL` sorts undated batches last, because an undated batch keeps indefinitely
 * and there is never a reason to reach for it ahead of one with a deadline.
 *
 * Ties are broken by `received_at` then `batch_number` so the result is a total order. MongoDB's
 * `summarizeBatches` breaks the same tie by array position; two batches sharing an expiry date to
 * the millisecond is not a case any test or shelf distinguishes, and a deterministic answer on
 * each engine matters more than agreeing on which one.
 */
function summaryAssignments(itemId: string, now: string) {
  const fefo = sql`ORDER BY b.expiry_date IS NULL, b.expiry_date, b.received_at, b.batch_number`;
  const chosen = sql`(
    SELECT b.batch_number FROM inventory_batches b
     WHERE b.item_id = ${itemId} AND b.quantity > 0 ${fefo} LIMIT 1
  )`;
  const chosenExpiry = sql`(
    SELECT b.expiry_date FROM inventory_batches b
     WHERE b.item_id = ${itemId} AND b.quantity > 0 ${fefo} LIMIT 1
  )`;
  const total = sql`(
    SELECT COALESCE(SUM(b.quantity), 0) FROM inventory_batches b WHERE b.item_id = ${itemId}
  )`;

  return {
    availableQuantity: total,
    batchNumber: sql`COALESCE(${chosen}, '')`,
    expiryDate: chosenExpiry,
    stockState: sql`CASE
      WHEN ${total} <= 0 THEN 'out_of_stock'
      WHEN ${total} <= ${inventoryItems.minimumStock} THEN 'low'
      ELSE 'ok'
    END`,
    updatedAt: now,
  };
}

/**
 * The ledger INSERT, with `previous_quantity` and `new_quantity` read out of the item row.
 *
 * Placed last in every batch, so `available_quantity` is already the post-operation value.
 * `previous` is derived by undoing the delta rather than being carried in from the caller's
 * read — see the header.
 */
function ledgerInsert(
  db: Database,
  params: {
    id: string;
    item: ItemRow;
    action: StockAction;
    quantity: number;
    delta: number;
    batchNumber: string;
    expiryDate: string | null;
    supplier?: string;
    storageLocation?: string;
    target?: IssueStockInput['target'];
    context: StockContext;
    notes?: string;
    createdAt: string;
  },
): BatchItem<'sqlite'> {
  /**
   * A correlated read of the item's counter, evaluated when this statement runs.
   *
   * The whole point of the subquery is that it is *not* a value captured in JavaScript: by the
   * time the insert executes, the earlier statements in the same batch have already applied the
   * delta, so this is the true post-operation figure however many racers were involved.
   */
  const newQuantity = sql`(SELECT available_quantity FROM inventory_items WHERE id = ${params.item.id})`;

  return db.insert(stockTransactions).values({
    id: params.id,
    organizationId: params.item.organization_id,
    itemId: params.item.id,
    itemCode: params.item.code,
    itemName: params.item.name,
    departmentId: params.item.department_id,
    action: params.action,
    quantity: params.quantity,
    quantityDelta: params.delta,
    previousQuantity: sql`${newQuantity} - ${params.delta}`,
    newQuantity,
    unit: params.item.unit,
    batchNumber: params.batchNumber,
    expiryDate: params.expiryDate,
    supplier: params.supplier ?? '',
    storageLocation: params.storageLocation ?? '',
    issuedToType: params.target?.type ?? null,
    issuedToUserId: params.target?.userId ?? null,
    issuedToDepartmentId: params.target?.departmentId ?? null,
    projectId: params.target?.projectId ?? null,
    experimentId: params.target?.experimentId ?? null,
    issuedToLabel: params.target?.label ?? '',
    purpose: params.context.purpose ?? '',
    notes: params.notes ?? params.context.notes ?? '',
    performedBy: params.context.performedBy,
    performedByName: params.context.performedByName,
    performedAt: params.context.performedAt.toISOString(),
    requestId: params.context.requestId ?? null,
    createdAt: params.createdAt,
  });
}

/* ------------------------------------------------------------------ reads */

async function loadItemRow(db: Database, id: string): Promise<ItemRow | null> {
  const rows = await db.all<ItemRow>(
    sql`SELECT * FROM inventory_items WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`,
  );
  return rows[0] ?? null;
}

async function loadBatchRows(db: Database, itemId: string): Promise<BatchRow[]> {
  return db.all<BatchRow>(
    sql`SELECT * FROM inventory_batches WHERE item_id = ${itemId}
        ORDER BY expiry_date IS NULL, expiry_date, received_at, batch_number`,
  );
}

async function loadRecord(db: Database, id: string): Promise<InventoryItemRecord | null> {
  const row = await loadItemRow(db, id);
  if (!row) return null;
  return toRecord(row, await loadBatchRows(db, id));
}

export async function findById(id: string): Promise<InventoryItemRecord | null> {
  return loadRecord(await getD1(), id);
}

export async function findByCode(
  organizationId: string,
  code: string,
): Promise<InventoryItemRecord | null> {
  const db = await getD1();
  const rows = await db.all<ItemRow>(
    sql`SELECT * FROM inventory_items
         WHERE organization_id = ${organizationId} AND code = ${code.toUpperCase()}
           AND deleted_at IS NULL
         LIMIT 1`,
  );
  const row = rows[0];
  return row ? toRecord(row, await loadBatchRows(db, row.id)) : null;
}

const SORT_COLUMNS: Record<NonNullable<ListInventoryItemsInput['sort']>, string> = {
  name: 'name',
  code: 'code',
  quantity: 'available_quantity',
  expiry: 'expiry_date',
  updated: 'updated_at',
};

/**
 * The filter chips, as SQL.
 *
 * `LIKE` with an escaped pattern rather than FTS, for the same reason the MongoDB side uses a
 * literal regex: item codes and batch numbers are punctuation-heavy identifiers that a tokenizer
 * would split into pieces nobody types. Every query is already narrowed to one organization, so
 * the scan is over a catalogue of thousands, not an archive of millions.
 */
function likeParam(value: string): string {
  // `\` escapes itself, `%` and `_`; the statement declares ESCAPE '\'. Without this a search
  // for "50%" matches everything beginning "50".
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function listConditions(input: ListInventoryItemsInput) {
  const conditions = [
    sql`i.organization_id = ${input.organizationId}`,
    sql`i.deleted_at IS NULL`,
  ];

  if (input.category) conditions.push(sql`i.category = ${input.category}`);
  if (input.status) conditions.push(sql`i.status = ${input.status}`);
  if (input.departmentId) conditions.push(sql`i.department_id = ${input.departmentId}`);
  if (input.supplier) {
    conditions.push(sql`i.supplier LIKE ${likeParam(input.supplier)} ESCAPE '\\'`);
  }
  if (input.storageLocation) {
    conditions.push(sql`i.storage_location LIKE ${likeParam(input.storageLocation)} ESCAPE '\\'`);
  }

  const now = input.now.toISOString();
  switch (input.stockFilter) {
    case 'available':
      conditions.push(sql`i.available_quantity > 0`);
      break;
    case 'low':
      conditions.push(sql`i.stock_state = 'low'`);
      break;
    case 'out_of_stock':
      conditions.push(sql`i.stock_state = 'out_of_stock'`);
      break;
    case 'near_expiry':
      conditions.push(
        sql`i.available_quantity > 0 AND i.expiry_date >= ${now}
            AND i.expiry_date <= ${nearExpiryCutoff(input.now).toISOString()}`,
      );
      break;
    case 'expired':
      conditions.push(sql`i.available_quantity > 0 AND i.expiry_date < ${now}`);
      break;
    default:
      break;
  }

  if (input.q) {
    const term = likeParam(input.q);
    conditions.push(sql`(
      i.name LIKE ${term} ESCAPE '\\' OR
      i.code LIKE ${term} ESCAPE '\\' OR
      i.supplier LIKE ${term} ESCAPE '\\' OR
      i.storage_location LIKE ${term} ESCAPE '\\' OR
      i.description LIKE ${term} ESCAPE '\\' OR
      EXISTS (SELECT 1 FROM inventory_batches b
               WHERE b.item_id = i.id AND b.batch_number LIKE ${term} ESCAPE '\\')
    )`);
  }

  return sql.join(conditions, sql` AND `);
}

export async function list(
  input: ListInventoryItemsInput,
): Promise<{ items: InventoryItemRecord[]; total: number }> {
  const db = await getD1();
  const where = listConditions(input);

  const column = SORT_COLUMNS[input.sort ?? 'name'];
  const direction = input.order === 'desc' ? 'DESC' : 'ASC';
  const offset = (input.page - 1) * input.pageSize;

  /**
   * `i.id` is a second sort key on every listing, not decoration.
   *
   * Without one, two items with the same name can swap places between pages and a reader sees
   * the same row twice while missing another. The column name is chosen from a fixed map above,
   * never interpolated from a request.
   */
  const rows = await db.all<ItemRow>(sql`
    SELECT i.* FROM inventory_items i
     WHERE ${where}
     ORDER BY ${sql.raw(`i.${column}`)} ${sql.raw(direction)}, i.id ASC
     LIMIT ${input.pageSize} OFFSET ${offset}
  `);

  const [countRow] = await db.all<{ total: number }>(sql`
    SELECT COUNT(*) AS total FROM inventory_items i WHERE ${where}
  `);

  // One query for every batch on the page rather than one per item: a 50-item page would
  // otherwise be 51 round trips, and D1 charges for each.
  const ids = rows.map((row) => row.id);
  const batches = ids.length
    ? await db.all<BatchRow>(sql`
        SELECT * FROM inventory_batches
         WHERE item_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
         ORDER BY expiry_date IS NULL, expiry_date, received_at, batch_number
      `)
    : [];

  const byItem = new Map<string, BatchRow[]>();
  for (const batch of batches) {
    const list = byItem.get(batch.item_id);
    if (list) list.push(batch);
    else byItem.set(batch.item_id, [batch]);
  }

  return {
    items: rows.map((row) => toRecord(row, byItem.get(row.id) ?? [])),
    total: Number(countRow?.total ?? 0),
  };
}

export async function dashboard(
  organizationId: string,
  now: Date,
): Promise<InventoryDashboard> {
  const db = await getD1();
  const nowIso = now.toISOString();
  const cutoff = nearExpiryCutoff(now).toISOString();

  const [row] = await db.all<{
    total: number;
    ok: number;
    low: number;
    out_of_stock: number;
    near_expiry: number;
    expired: number;
  }>(sql`
    SELECT
      COUNT(*)                                                                      AS total,
      SUM(CASE WHEN stock_state = 'ok' THEN 1 ELSE 0 END)                           AS ok,
      SUM(CASE WHEN stock_state = 'low' THEN 1 ELSE 0 END)                          AS low,
      SUM(CASE WHEN stock_state = 'out_of_stock' THEN 1 ELSE 0 END)                 AS out_of_stock,
      SUM(CASE WHEN available_quantity > 0 AND expiry_date >= ${nowIso}
                AND expiry_date <= ${cutoff} THEN 1 ELSE 0 END)                     AS near_expiry,
      SUM(CASE WHEN available_quantity > 0 AND expiry_date < ${nowIso}
               THEN 1 ELSE 0 END)                                                   AS expired
      FROM inventory_items
     WHERE organization_id = ${organizationId} AND deleted_at IS NULL
  `);

  return {
    totalItems: Number(row?.total ?? 0),
    byStockState: {
      ok: Number(row?.ok ?? 0),
      low: Number(row?.low ?? 0),
      out_of_stock: Number(row?.out_of_stock ?? 0),
    },
    nearExpiry: Number(row?.near_expiry ?? 0),
    expired: Number(row?.expired ?? 0),
  };
}

/* ------------------------------------------------------------------ item writes */

export async function create(input: CreateInventoryItemInput): Promise<InventoryItemRecord> {
  const db = await getD1();
  const id = newId();
  const now = new Date().toISOString();

  await db.run(sql`
    INSERT INTO inventory_items (
      id, organization_id, department_id, name, code, category, unit, description,
      available_quantity, minimum_stock, stock_state, batch_number, expiry_date,
      storage_location, supplier, status, created_by, created_at, updated_at
    ) VALUES (
      ${id}, ${input.organizationId}, ${input.departmentId ?? null}, ${input.name},
      ${input.code.toUpperCase()}, ${input.category}, ${input.unit}, ${input.description ?? ''},
      0, ${input.minimumStock}, 'out_of_stock', '', NULL,
      ${input.storageLocation ?? ''}, ${input.supplier ?? ''}, ${input.status},
      ${input.createdBy}, ${now}, ${now}
    )
  `);

  for (const fileId of input.documentFileIds ?? []) {
    await db.run(sql`
      INSERT OR IGNORE INTO inventory_item_documents (item_id, file_id) VALUES (${id}, ${fileId})
    `);
  }

  const record = await loadRecord(db, id);
  if (!record) throw new Error('The inventory item vanished immediately after being created');
  return record;
}

export async function update(
  id: string,
  fields: UpdateInventoryItemFields,
): Promise<InventoryItemRecord | null> {
  const db = await getD1();

  const assignments = [sql`updated_by = ${fields.updatedBy}`, sql`updated_at = ${new Date().toISOString()}`];
  if (fields.name !== undefined) assignments.push(sql`name = ${fields.name}`);
  if (fields.category !== undefined) assignments.push(sql`category = ${fields.category}`);
  if (fields.unit !== undefined) assignments.push(sql`unit = ${fields.unit}`);
  if (fields.departmentId !== undefined) {
    assignments.push(sql`department_id = ${fields.departmentId}`);
  }
  if (fields.description !== undefined) assignments.push(sql`description = ${fields.description}`);
  if (fields.minimumStock !== undefined) {
    assignments.push(sql`minimum_stock = ${fields.minimumStock}`);
  }
  if (fields.stockState !== undefined) assignments.push(sql`stock_state = ${fields.stockState}`);
  if (fields.storageLocation !== undefined) {
    assignments.push(sql`storage_location = ${fields.storageLocation}`);
  }
  if (fields.supplier !== undefined) assignments.push(sql`supplier = ${fields.supplier}`);
  if (fields.status !== undefined) assignments.push(sql`status = ${fields.status}`);

  await db.run(sql`
    UPDATE inventory_items SET ${sql.join(assignments, sql`, `)}
     WHERE id = ${id} AND deleted_at IS NULL
  `);

  if (fields.documentFileIds !== undefined) {
    await db.run(sql`DELETE FROM inventory_item_documents WHERE item_id = ${id}`);
    for (const fileId of fields.documentFileIds) {
      await db.run(sql`
        INSERT OR IGNORE INTO inventory_item_documents (item_id, file_id) VALUES (${id}, ${fileId})
      `);
    }
  }

  return loadRecord(db, id);
}

export async function softDelete(id: string, deletedBy: string): Promise<boolean> {
  const db = await getD1();
  const result = await db.run(sql`
    UPDATE inventory_items
       SET deleted_at = ${new Date().toISOString()}, deleted_by = ${deletedBy}, status = 'inactive'
     WHERE id = ${id} AND deleted_at IS NULL
  `);
  return (result.meta?.changes ?? 0) > 0;
}

/* ------------------------------------------------------------------ stock movement */

async function requireItem(db: Database, itemId: string): Promise<ItemRow> {
  const row = await loadItemRow(db, itemId);
  if (!row) throw new UnknownBatchError('');
  return row;
}

async function readBack(
  db: Database,
  itemId: string,
  transactionId: string,
): Promise<StockResult> {
  const item = await loadRecord(db, itemId);
  const [transaction] = await db.all<TransactionRow>(
    sql`SELECT * FROM stock_transactions WHERE id = ${transactionId} LIMIT 1`,
  );
  if (!item || !transaction) {
    throw new Error('The stock operation committed but could not be read back');
  }
  return { item, transaction: toTransactionRecord(transaction) };
}

export async function receive(input: ReceiveStockInput): Promise<StockResult> {
  const db = await getD1();
  const item = await requireItem(db, input.itemId);
  const transactionId = newId();
  const now = new Date().toISOString();
  const expiry = iso(input.expiryDate);

  /**
   * An upsert keyed on `(item_id, batch_number)`, which is what `ux_inventory_batches` enforces.
   *
   * Receiving more of a batch already on the shelf tops it up rather than creating a second row
   * carrying the same number printed on the label. `received_at` is reset only when the row was
   * empty — a top-up of live stock keeps the original receipt date, but a re-receipt into a batch
   * that had been consumed is a new delivery and dates from today. That also keeps the row in
   * step with MongoDB, which pruned the empty batch and would create a fresh one here.
   */
  const receivedAt = input.performedAt.toISOString();

  const statements: BatchItem<'sqlite'>[] = [
    db
      .insert(inventoryBatches)
      .values({
        id: newId(),
        itemId: item.id,
        batchNumber: input.batchNumber,
        quantity: input.quantity,
        expiryDate: expiry,
        supplier: input.supplier ?? item.supplier,
        storageLocation: input.storageLocation ?? item.storage_location,
        receivedAt,
        receivedBy: input.performedBy,
        receiptTransactionId: transactionId,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [inventoryBatches.itemId, inventoryBatches.batchNumber],
        set: {
          quantity: sql`${inventoryBatches.quantity} + ${input.quantity}`,
          expiryDate: sql`COALESCE(${expiry}, ${inventoryBatches.expiryDate})`,
          ...(input.supplier !== undefined ? { supplier: input.supplier } : {}),
          ...(input.storageLocation !== undefined
            ? { storageLocation: input.storageLocation }
            : {}),
          // A top-up of live stock keeps its original receipt date; a re-receipt into a batch
          // that had been fully consumed is a new delivery and dates from today. That also keeps
          // the row in step with MongoDB, which pruned the empty batch and creates a fresh one.
          receivedAt: sql`CASE WHEN ${inventoryBatches.quantity} = 0 THEN ${receivedAt} ELSE ${inventoryBatches.receivedAt} END`,
          receiptTransactionId: transactionId,
        },
      }),
    db.update(inventoryItems).set(summaryAssignments(item.id, now)).where(eq(inventoryItems.id, item.id)),
    ledgerInsert(db, {
      id: transactionId,
      item,
      action: 'added',
      quantity: input.quantity,
      delta: input.quantity,
      batchNumber: input.batchNumber,
      expiryDate: expiry,
      supplier: input.supplier ?? '',
      storageLocation: input.storageLocation ?? '',
      context: input,
      createdAt: now,
    }),
  ];

  try {
    await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  } catch (error) {
    translateConstraint(error, item.unit, input.quantity);
  }

  return readBack(db, item.id, transactionId);
}

export async function issue(input: IssueStockInput): Promise<StockResult> {
  const db = await getD1();
  const item = await requireItem(db, input.itemId);
  const transactionId = newId();
  const now = new Date().toISOString();
  const total = input.allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);

  const statements: BatchItem<'sqlite'>[] = [];

  /**
   * Phase 1 — the per-batch decrements, which are the real gate.
   *
   * Unconditional arithmetic backed by `CHECK (quantity >= 0)`. A concurrent issue that already
   * took the stock makes this statement drive the row negative, the CHECK aborts the batch, and
   * nothing at all commits — not the other decrements, not the item summary, not the ledger row.
   */
  for (const allocation of input.allocations) {
    statements.push(
      db
        .update(inventoryBatches)
        .set({ quantity: sql`${inventoryBatches.quantity} - ${allocation.quantity}` })
        .where(
          and(
            eq(inventoryBatches.itemId, item.id),
            eq(inventoryBatches.batchNumber, allocation.batchNumber),
          ),
        ),
    );
  }

  /**
   * Phase 2 — the item's own counter, as a second CHECK-backed gate.
   *
   * Redundant when the plan is sound, and deliberately kept: it is what catches a plan that
   * under-allocates against a batch row that no longer exists, which would otherwise leave the
   * ledger claiming more than actually came off the shelf.
   */
  statements.push(
    db
      .update(inventoryItems)
      .set({ availableQuantity: sql`${inventoryItems.availableQuantity} - ${total}` })
      .where(eq(inventoryItems.id, item.id)),
  );

  // Phase 3 — make the counter exact and re-derive the label columns from the batch table.
  statements.push(
    db
      .update(inventoryItems)
      .set(summaryAssignments(item.id, now))
      .where(eq(inventoryItems.id, item.id)),
  );

  statements.push(
    ledgerInsert(db, {
      id: transactionId,
      item,
      action: 'issued',
      quantity: total,
      delta: -total,
      // A multi-batch issue records every batch it drew from. Splitting the ledger row per batch
      // would make one physical handover look like several.
      batchNumber: input.allocations.map((allocation) => allocation.batchNumber).join(', '),
      expiryDate: iso(input.allocations[0]?.expiryDate ?? null),
      target: input.target,
      context: input,
      createdAt: now,
    }),
  );

  try {
    await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  } catch (error) {
    translateConstraint(error, item.unit, total);
  }

  return readBack(db, item.id, transactionId);
}

export async function adjust(input: AdjustStockInput): Promise<StockResult> {
  const db = await getD1();
  const item = await requireItem(db, input.itemId);
  const transactionId = newId();
  const now = new Date().toISOString();
  const expiry = iso(input.expiryDate ?? null);

  const existing = await db.all<BatchRow>(
    sql`SELECT * FROM inventory_batches
         WHERE item_id = ${item.id} AND batch_number = ${input.batchNumber} LIMIT 1`,
  );

  if (input.delta < 0 && existing.length === 0) {
    throw new UnknownBatchError(input.batchNumber);
  }

  /**
   * The two signs take different statements, and that is not tidiness.
   *
   * SQLite validates CHECK constraints on the candidate row **before** it resolves the UNIQUE
   * conflict, so an upsert carrying `quantity = -3` trips `ck_inventory_batches_quantity` and
   * aborts — even though the DO UPDATE branch would have produced a perfectly legal positive
   * value. The failure looks exactly like an overdraw, which is what makes it worth a comment
   * rather than a workaround.
   *
   * A negative adjustment therefore uses a plain UPDATE, which is sound because the batch is
   * required to exist: `UnknownBatchError` was already thrown above if it does not. `CHECK` is
   * still the gate on overdrawing it.
   */
  const statements: BatchItem<'sqlite'>[] = [
    input.delta < 0
      ? db
          .update(inventoryBatches)
          .set({
            quantity: sql`${inventoryBatches.quantity} + ${input.delta}`,
            ...(expiry ? { expiryDate: expiry } : {}),
          })
          .where(
            and(
              eq(inventoryBatches.itemId, item.id),
              eq(inventoryBatches.batchNumber, input.batchNumber),
            ),
          )
      : // A recount that finds material the system did not know about is a real outcome, so a
        // positive adjustment may create the batch. It is still a ledger row that explains itself.
        db
          .insert(inventoryBatches)
          .values({
            id: newId(),
            itemId: item.id,
            batchNumber: input.batchNumber,
            quantity: input.delta,
            expiryDate: expiry,
            supplier: item.supplier,
            storageLocation: item.storage_location,
            receivedAt: input.performedAt.toISOString(),
            receivedBy: input.performedBy,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [inventoryBatches.itemId, inventoryBatches.batchNumber],
            set: {
              quantity: sql`${inventoryBatches.quantity} + ${input.delta}`,
              expiryDate: sql`COALESCE(${expiry}, ${inventoryBatches.expiryDate})`,
            },
          }),
    db
      .update(inventoryItems)
      .set(summaryAssignments(item.id, now))
      .where(eq(inventoryItems.id, item.id)),
    ledgerInsert(db, {
      id: transactionId,
      item,
      action: 'adjusted',
      quantity: Math.abs(input.delta),
      delta: input.delta,
      batchNumber: input.batchNumber,
      expiryDate: expiry ?? existing[0]?.expiry_date ?? null,
      context: input,
      // The reason is mandatory on an adjustment and is stored where an auditor reads it.
      notes: input.notes ? `${input.reason} — ${input.notes}` : input.reason,
      createdAt: now,
    }),
  ];

  try {
    await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  } catch (error) {
    translateConstraint(error, item.unit, Math.abs(input.delta));
  }

  return readBack(db, item.id, transactionId);
}

export async function expire(input: ExpireStockInput): Promise<StockTransactionRecord[]> {
  const db = await getD1();
  const nowIso = input.now.toISOString();

  const candidates = await db.all<{ item_id: string; lost: number; batches: string }>(sql`
    SELECT b.item_id                       AS item_id,
           SUM(b.quantity)                 AS lost,
           GROUP_CONCAT(b.batch_number, ', ') AS batches
      FROM inventory_batches b
      JOIN inventory_items i ON i.id = b.item_id
     WHERE i.organization_id = ${input.organizationId}
       AND i.deleted_at IS NULL
       AND b.quantity > 0
       AND b.expiry_date IS NOT NULL
       AND b.expiry_date < ${nowIso}
     GROUP BY b.item_id
  `);

  const written: StockTransactionRecord[] = [];

  for (const candidate of candidates) {
    const item = await loadItemRow(db, candidate.item_id);
    if (!item) continue;

    const transactionId = newId();
    const performedBy = input.performedBy ?? null;
    const performedByName = input.performedByName ?? 'Expiry sweep';
    const notes = 'Written off automatically: past expiry date';

    /**
     * One `batch()` per item rather than one for the whole sweep.
     *
     * A single transaction across hundreds of items would abort all of them because one had a
     * concurrent issue in flight, and the next run would abort for the same reason. Per item, a
     * conflict costs that item and the rest are still written off.
     *
     * **The ledger row is the first statement, and it derives everything from the rows as they
     * stand when the batch runs** — the amount, the batch numbers, the before/after figures —
     * with `HAVING SUM(quantity) > 0` as its guard. Two sweeps can overlap (the cron, an
     * administrator's click, an at-least-once queue redelivery) and both read the same
     * candidates above. The batches serialize: the first writes the item off; the second finds
     * nothing left, inserts no row, and zeroes nothing. Built from the candidate read instead,
     * the second sweep inserted a phantom `8 → 0` write-off of stock that was already gone.
     */
    const statements: BatchItem<'sqlite'>[] = [
      db.insert(stockTransactions).select(
        sql`SELECT ${transactionId}, i.organization_id, i.id, i.code, i.name, i.department_id,
                   'expired', SUM(b.quantity), -SUM(b.quantity),
                   i.available_quantity, i.available_quantity - SUM(b.quantity), i.unit,
                   GROUP_CONCAT(b.batch_number, ', '), NULL, '', '',
                   NULL, NULL, NULL, NULL, NULL, '',
                   '', ${notes}, ${performedBy}, ${performedByName}, ${nowIso}, NULL, ${nowIso}
              FROM inventory_batches b
              JOIN inventory_items i ON i.id = b.item_id
             WHERE b.item_id = ${item.id}
               AND i.deleted_at IS NULL
               AND b.quantity > 0
               AND b.expiry_date IS NOT NULL
               AND b.expiry_date < ${nowIso}
             GROUP BY i.id
            HAVING SUM(b.quantity) > 0`,
      ),
      db
        .update(inventoryBatches)
        .set({ quantity: 0 })
        .where(
          and(
            eq(inventoryBatches.itemId, item.id),
            gt(inventoryBatches.quantity, 0),
            isNotNull(inventoryBatches.expiryDate),
            lt(inventoryBatches.expiryDate, nowIso),
          ),
        ),
      db
        .update(inventoryItems)
        .set(summaryAssignments(item.id, nowIso))
        .where(eq(inventoryItems.id, item.id)),
    ];

    await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

    // Present only if this sweep, not a concurrent one, wrote the item off.
    const [row] = await db.all<TransactionRow>(
      sql`SELECT * FROM stock_transactions WHERE id = ${transactionId} LIMIT 1`,
    );
    if (row) written.push(toTransactionRecord(row));
  }

  return written;
}

/* ------------------------------------------------------------------ ledger reads */

export async function listHistory(
  input: ListStockHistoryInput,
): Promise<{ transactions: StockTransactionRecord[]; total: number }> {
  const db = await getD1();

  const conditions = [sql`organization_id = ${input.organizationId}`];
  if (input.itemId) conditions.push(sql`item_id = ${input.itemId}`);
  if (input.action) conditions.push(sql`action = ${input.action}`);
  if (input.projectId) conditions.push(sql`project_id = ${input.projectId}`);
  if (input.experimentId) conditions.push(sql`experiment_id = ${input.experimentId}`);
  if (input.issuedToUserId) conditions.push(sql`issued_to_user_id = ${input.issuedToUserId}`);
  if (input.performedBy) conditions.push(sql`performed_by = ${input.performedBy}`);
  if (input.from) conditions.push(sql`performed_at >= ${input.from.toISOString()}`);
  if (input.to) conditions.push(sql`performed_at < ${input.to.toISOString()}`);

  const where = sql.join(conditions, sql` AND `);
  const offset = (input.page - 1) * input.pageSize;

  const rows = await db.all<TransactionRow>(sql`
    SELECT * FROM stock_transactions WHERE ${where}
     ORDER BY performed_at DESC, id DESC
     LIMIT ${input.pageSize} OFFSET ${offset}
  `);

  const [countRow] = await db.all<{ total: number }>(
    sql`SELECT COUNT(*) AS total FROM stock_transactions WHERE ${where}`,
  );

  return {
    transactions: rows.map(toTransactionRecord),
    total: Number(countRow?.total ?? 0),
  };
}

export async function findTransactionById(id: string): Promise<StockTransactionRecord | null> {
  const db = await getD1();
  const [row] = await db.all<TransactionRow>(
    sql`SELECT * FROM stock_transactions WHERE id = ${id} LIMIT 1`,
  );
  return row ? toTransactionRecord(row) : null;
}

export const d1InventoryRepository: InventoryRepository = {
  findById,
  findByCode,
  list,
  dashboard,
  create,
  update,
  softDelete,
  receive,
  issue,
  adjust,
  expire,
  listHistory,
  findTransactionById,
};
