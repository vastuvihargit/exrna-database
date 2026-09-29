/**
 * The MongoDB inventory repository — items, batches and the stock ledger.
 *
 * The item CRUD half is the code that has been serving production; it moved behind the contract
 * unchanged except for `update`, whose signature was `Record<string, unknown>` and is now a
 * closed field set (see the note on `UpdateInventoryItemFields`).
 *
 * The stock half is new, and its whole design is the paragraph below.
 *
 * ── Every stock operation is one transaction ────────────────────────────────────────────
 *
 * Moving stock writes two collections: the item's batches and a ledger row. Splitting them
 * leaves the worst possible failure — material gone from the count with nothing recording where
 * it went, or a ledger claiming an issue that never left the shelf. `withTransaction` makes both
 * or neither, on a replica set, which this deployment is.
 *
 * ── What actually prevents an overdraw ──────────────────────────────────────────────────
 *
 * The availability check is a plain comparison, and it is sound **because of where it sits**:
 * inside the transaction, against a document read inside the same transaction.
 *
 * Two concurrent issues write the same document, so the second raises a MongoDB write conflict
 * and `session.withTransaction` retries it. The retry re-runs the callback from the top, so the
 * loser re-reads the decremented quantity and is refused. Snapshot isolation plus the automatic
 * retry is the mechanism; the comparison is just how the refusal is expressed.
 *
 * An earlier version used `updateOne` with `arrayFilters` and treated `modifiedCount === 0` as
 * "somebody got there first". It read convincingly and did not work — the driver reports the
 * parent document as matched, so an issue that changed nothing reported success. A test caught
 * it. Checking a value this code is holding beats checking a counter whose meaning belongs to
 * the driver.
 *
 * ── The ledger's before/after figures come from the written document ────────────────────
 *
 * `findOneAndUpdate({ new: true })` returns the item *after* the write, so `newQuantity` is
 * observed rather than predicted and `previousQuantity` is derived from it. Because the read,
 * the check and the write are all in the retried transaction, the pair always describes the
 * transition that actually committed.
 */
import { Types, type FilterQuery } from 'mongoose';
import { connectToDatabase, withTransaction } from '@/server/db/connection';
import {
  InventoryItemModel,
  StockTransactionModel,
  type InventoryItemDocument,
  type StockTransactionDocument,
} from '@/server/db/models';
import {
  nearExpiryCutoff,
  stockStateFor,
  summarizeBatches,
  type StockState,
} from '@/server/domain/inventory';
import type { StockAction } from '@/server/db/models/stock-transaction.model';
import {
  ExpiredBatchError,
  InsufficientStockError,
  UnknownBatchError,
  type AdjustStockInput,
  type CreateInventoryItemInput,
  type ExpireStockInput,
  type InventoryDashboard,
  type InventoryItemRecord,
  type InventoryRepository,
  type InventoryTx,
  type IssueStockInput,
  type ListInventoryItemsInput,
  type ListStockHistoryInput,
  type ReceiveStockInput,
  type StockContext,
  type StockResult,
  type StockTransactionRecord,
  type UpdateInventoryItemFields,
} from './inventory-item.repository.contract';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

function optionalOid(value: string | null | undefined): Types.ObjectId | null {
  return value ? oid(value) : null;
}

type LeanInventoryItem = InventoryItemDocument & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

type LeanStockTransaction = StockTransactionDocument & {
  _id: Types.ObjectId;
  createdAt: Date;
};

function toRecord(doc: LeanInventoryItem): InventoryItemRecord {
  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    departmentId: doc.departmentId ? String(doc.departmentId) : null,
    name: doc.name,
    code: doc.code,
    category: doc.category as InventoryItemRecord['category'],
    unit: doc.unit as InventoryItemRecord['unit'],
    description: doc.description ?? '',
    availableQuantity: doc.availableQuantity ?? 0,
    minimumStock: doc.minimumStock ?? 0,
    stockState: doc.stockState as StockState,
    batches: (doc.batches ?? []).map((batch) => ({
      // MongoDB keys a batch by its number within its item; there is no synthetic id, and
      // inventing one here would be a second identifier that can disagree with the label.
      id: null,
      batchNumber: batch.batchNumber,
      quantity: batch.quantity,
      expiryDate: batch.expiryDate ?? null,
      supplier: batch.supplier ?? '',
      storageLocation: batch.storageLocation ?? '',
      receivedAt: batch.receivedAt ?? new Date(0),
      receivedBy: batch.receivedBy ? String(batch.receivedBy) : null,
      receiptTransactionId: batch.receiptTransactionId ? String(batch.receiptTransactionId) : null,
    })),
    batchNumber: doc.batchNumber ?? '',
    expiryDate: doc.expiryDate ?? null,
    storageLocation: doc.storageLocation ?? '',
    supplier: doc.supplier ?? '',
    status: doc.status as InventoryItemRecord['status'],
    documentFileIds: (doc.documentFileIds ?? []).map(String),
    createdBy: String(doc.createdBy),
    updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toTransactionRecord(doc: LeanStockTransaction): StockTransactionRecord {
  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    itemId: String(doc.itemId),
    itemCode: doc.itemCode,
    itemName: doc.itemName,
    departmentId: doc.departmentId ? String(doc.departmentId) : null,
    action: doc.action as StockAction,
    quantity: doc.quantity,
    quantityDelta: doc.quantityDelta,
    previousQuantity: doc.previousQuantity,
    newQuantity: doc.newQuantity,
    unit: doc.unit,
    batchNumber: doc.batchNumber ?? '',
    expiryDate: doc.expiryDate ?? null,
    supplier: doc.supplier ?? '',
    storageLocation: doc.storageLocation ?? '',
    issuedToType: (doc.issuedToType as StockTransactionRecord['issuedToType']) ?? null,
    issuedToUserId: doc.issuedToUserId ? String(doc.issuedToUserId) : null,
    issuedToDepartmentId: doc.issuedToDepartmentId ? String(doc.issuedToDepartmentId) : null,
    projectId: doc.projectId ? String(doc.projectId) : null,
    experimentId: doc.experimentId ? String(doc.experimentId) : null,
    issuedToLabel: doc.issuedToLabel ?? '',
    purpose: doc.purpose ?? '',
    notes: doc.notes ?? '',
    performedBy: doc.performedBy ? String(doc.performedBy) : null,
    performedByName: doc.performedByName ?? '',
    performedAt: doc.performedAt,
    requestId: doc.requestId ?? null,
    createdAt: doc.createdAt,
  };
}

/**
 * Turns a search term into a literal, so it can never be a pattern.
 *
 * The search below is a case-insensitive substring match rather than a `$text` query. Item codes
 * and batch numbers are punctuation-heavy identifiers (`CHM-0042`, `LOT/24/B`) and a text index
 * tokenizes them into pieces nobody types; searching for "chm-00" would find nothing. The cost is
 * that the match itself cannot use an index — acceptable because every query is already narrowed
 * to one organization, and a company's catalogue of materials is thousands of rows, not millions.
 *
 * Escaping every metacharacter is what keeps that safe: the resulting expression is a literal
 * string match, so no user input can turn it into a catastrophically backtracking pattern.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ reads */

export async function findById(id: string): Promise<InventoryItemRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectToDatabase();
  const doc = await InventoryItemModel.findOne({ _id: oid(id) }).lean<LeanInventoryItem>().exec();
  return doc ? toRecord(doc) : null;
}

export async function findByCode(
  organizationId: string,
  code: string,
): Promise<InventoryItemRecord | null> {
  await connectToDatabase();
  const doc = await InventoryItemModel.findOne({
    organizationId: oid(organizationId),
    code: code.toUpperCase(),
  })
    .lean<LeanInventoryItem>()
    .exec();
  return doc ? toRecord(doc) : null;
}

/** The indexed condition behind each filter chip. */
export function stockFilterCondition(
  filter: NonNullable<ListInventoryItemsInput['stockFilter']>,
  now: Date,
): FilterQuery<InventoryItemDocument> {
  switch (filter) {
    case 'available':
      return { availableQuantity: { $gt: 0 } };
    case 'low':
      return { stockState: 'low' };
    case 'out_of_stock':
      return { stockState: 'out_of_stock' };
    case 'near_expiry':
      // Only stock that still exists can be near expiry — an empty item with a stale date
      // is not something anybody needs to act on.
      return {
        availableQuantity: { $gt: 0 },
        expiryDate: { $gte: now, $lte: nearExpiryCutoff(now) },
      };
    case 'expired':
      return { availableQuantity: { $gt: 0 }, expiryDate: { $lt: now } };
  }
}

const SORT_FIELDS: Record<NonNullable<ListInventoryItemsInput['sort']>, string> = {
  name: 'name',
  code: 'code',
  quantity: 'availableQuantity',
  expiry: 'expiryDate',
  updated: 'updatedAt',
};

export async function list(
  input: ListInventoryItemsInput,
): Promise<{ items: InventoryItemRecord[]; total: number }> {
  await connectToDatabase();

  const conditions: FilterQuery<InventoryItemDocument>[] = [
    { organizationId: oid(input.organizationId) },
  ];

  if (input.category) conditions.push({ category: input.category });
  if (input.status) conditions.push({ status: input.status });
  if (input.departmentId && Types.ObjectId.isValid(input.departmentId)) {
    conditions.push({ departmentId: oid(input.departmentId) });
  }
  if (input.supplier) {
    conditions.push({ supplier: new RegExp(escapeRegex(input.supplier), 'i') });
  }
  if (input.storageLocation) {
    conditions.push({ storageLocation: new RegExp(escapeRegex(input.storageLocation), 'i') });
  }
  if (input.stockFilter) conditions.push(stockFilterCondition(input.stockFilter, input.now));

  if (input.q) {
    const term = new RegExp(escapeRegex(input.q), 'i');
    conditions.push({
      $or: [
        { name: term },
        { code: term },
        { supplier: term },
        { storageLocation: term },
        { description: term },
        { 'batches.batchNumber': term },
      ],
    });
  }

  const filter: FilterQuery<InventoryItemDocument> = { $and: conditions };

  const sortField = SORT_FIELDS[input.sort ?? 'name'];
  const direction = input.order === 'desc' ? -1 : 1;
  const skip = (input.page - 1) * input.pageSize;

  const [docs, total] = await Promise.all([
    InventoryItemModel.find(filter)
      // A stable secondary key: without one, two items with the same name can swap places
      // between pages and a reader sees the same row twice while missing another.
      .sort({ [sortField]: direction, _id: 1 })
      .skip(skip)
      .limit(input.pageSize)
      .lean<LeanInventoryItem[]>()
      .exec(),
    InventoryItemModel.countDocuments(filter).exec(),
  ]);

  return { items: docs.map(toRecord), total };
}

export async function dashboard(
  organizationId: string,
  now: Date,
): Promise<InventoryDashboard> {
  await connectToDatabase();
  const scope: FilterQuery<InventoryItemDocument> = {
    organizationId: oid(organizationId),
    // `aggregate` is NOT routed through the soft-delete middleware — the same Mongoose
    // behaviour that made `searchFacets` count trashed files (see FINAL-READINESS §5.3). Stated
    // explicitly here so the next person does not delete it as redundant.
    deletedAt: null,
  };

  const [states, nearExpiry, expired, total] = await Promise.all([
    InventoryItemModel.aggregate<{ _id: StockState; count: number }>([
      { $match: scope },
      { $group: { _id: '$stockState', count: { $sum: 1 } } },
    ]).exec(),
    InventoryItemModel.countDocuments({
      ...scope,
      ...stockFilterCondition('near_expiry', now),
    }).exec(),
    InventoryItemModel.countDocuments({
      ...scope,
      ...stockFilterCondition('expired', now),
    }).exec(),
    InventoryItemModel.countDocuments(scope).exec(),
  ]);

  const byStockState: Record<StockState, number> = { ok: 0, low: 0, out_of_stock: 0 };
  for (const row of states) byStockState[row._id] = row.count;

  return { totalItems: total, byStockState, nearExpiry, expired };
}

/* ------------------------------------------------------------------ item writes */

/**
 * Creates the item definition only.
 *
 * `availableQuantity` and `batches` are deliberately absent from the input: an item comes into
 * existence empty and is filled by a receipt, which writes a ledger row. There is no route
 * through this repository that puts stock on a shelf without recording where it came from.
 */
export async function create(
  input: CreateInventoryItemInput,
  tx?: InventoryTx,
): Promise<InventoryItemRecord> {
  await connectToDatabase();
  const [doc] = await InventoryItemModel.create(
    [
      {
        organizationId: oid(input.organizationId),
        departmentId: optionalOid(input.departmentId),
        name: input.name,
        code: input.code.toUpperCase(),
        category: input.category,
        unit: input.unit,
        description: input.description ?? '',
        availableQuantity: 0,
        minimumStock: input.minimumStock,
        stockState: 'out_of_stock',
        batches: [],
        batchNumber: '',
        expiryDate: null,
        storageLocation: input.storageLocation ?? '',
        supplier: input.supplier ?? '',
        status: input.status,
        documentFileIds: (input.documentFileIds ?? []).map(oid),
        createdBy: oid(input.createdBy),
      },
    ],
    tx ? { session: tx } : undefined,
  );
  return toRecord(doc!.toObject() as LeanInventoryItem);
}

export async function update(
  id: string,
  fields: UpdateInventoryItemFields,
  tx?: InventoryTx,
): Promise<InventoryItemRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectToDatabase();

  const set: Record<string, unknown> = { updatedBy: oid(fields.updatedBy) };
  if (fields.name !== undefined) set.name = fields.name;
  if (fields.category !== undefined) set.category = fields.category;
  if (fields.unit !== undefined) set.unit = fields.unit;
  if (fields.departmentId !== undefined) set.departmentId = optionalOid(fields.departmentId);
  if (fields.description !== undefined) set.description = fields.description;
  if (fields.minimumStock !== undefined) set.minimumStock = fields.minimumStock;
  if (fields.stockState !== undefined) set.stockState = fields.stockState;
  if (fields.storageLocation !== undefined) set.storageLocation = fields.storageLocation;
  if (fields.supplier !== undefined) set.supplier = fields.supplier;
  if (fields.status !== undefined) set.status = fields.status;
  if (fields.documentFileIds !== undefined) {
    set.documentFileIds = fields.documentFileIds.map(oid);
  }

  const query = InventoryItemModel.findOneAndUpdate({ _id: oid(id) }, { $set: set }, { new: true });
  if (tx) query.session(tx);
  const doc = await query.lean<LeanInventoryItem>().exec();
  return doc ? toRecord(doc) : null;
}

export async function softDelete(id: string, deletedBy: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(id)) return false;
  await connectToDatabase();
  const result = await InventoryItemModel.updateOne(
    { _id: oid(id) },
    { $set: { deletedAt: new Date(), deletedBy: oid(deletedBy), status: 'inactive' } },
  ).exec();
  return result.modifiedCount > 0;
}

/* ------------------------------------------------------------------ stock movement */

/** The denormalized ledger fields that come off the item rather than the request. */
function ledgerBase(item: LeanInventoryItem) {
  return {
    organizationId: item.organizationId,
    itemId: item._id,
    itemCode: item.code,
    itemName: item.name,
    departmentId: item.departmentId ?? null,
    unit: item.unit,
  };
}

function contextFields(context: StockContext) {
  return {
    purpose: context.purpose ?? '',
    notes: context.notes ?? '',
    documentFileIds: (context.documentFileIds ?? []).map(oid),
    performedBy: optionalOid(context.performedBy),
    performedByName: context.performedByName,
    performedAt: context.performedAt,
    requestId: context.requestId ?? null,
  };
}

/**
 * Rewrites the four derived summary fields from the batch array.
 *
 * Called inside the same update as every batch change, never afterwards: a second write would
 * leave a window in which `availableQuantity` disagrees with `batches`, and the low-stock sweep
 * reads the summary rather than the array.
 */
function summaryUpdate(
  batches: readonly { batchNumber: string; quantity: number; expiryDate: Date | null }[],
  minimumStock: number,
) {
  const summary = summarizeBatches(batches);
  return {
    availableQuantity: summary.availableQuantity,
    batchNumber: summary.batchNumber,
    expiryDate: summary.expiryDate,
    stockState: stockStateFor(summary.availableQuantity, minimumStock),
  };
}

export async function receive(input: ReceiveStockInput): Promise<StockResult> {
  await connectToDatabase();

  return withTransaction(async (session) => {
    const item = await InventoryItemModel.findOne({ _id: oid(input.itemId) })
      .session(session)
      .lean<LeanInventoryItem>()
      .exec();
    if (!item) throw new UnknownBatchError(input.batchNumber);

    const batches = (item.batches ?? []).map((batch) => ({ ...batch }));
    const existing = batches.find((batch) => batch.batchNumber === input.batchNumber);

    if (existing) {
      // Receiving more of a batch already on the shelf tops it up rather than creating a
      // second row with the same number printed on it — the label is the identity.
      existing.quantity += input.quantity;
      if (input.expiryDate) existing.expiryDate = input.expiryDate;
      if (input.supplier) existing.supplier = input.supplier;
      if (input.storageLocation) existing.storageLocation = input.storageLocation;
    } else {
      batches.push({
        batchNumber: input.batchNumber,
        quantity: input.quantity,
        expiryDate: input.expiryDate,
        supplier: input.supplier ?? item.supplier ?? '',
        storageLocation: input.storageLocation ?? item.storageLocation ?? '',
        receivedAt: input.performedAt,
        receivedBy: optionalOid(input.performedBy),
        receiptTransactionId: null,
      } as (typeof batches)[number]);
    }

    const summary = summaryUpdate(
      batches.map((batch) => ({
        batchNumber: batch.batchNumber,
        quantity: batch.quantity,
        expiryDate: batch.expiryDate ?? null,
      })),
      item.minimumStock ?? 0,
    );

    const updated = await InventoryItemModel.findOneAndUpdate(
      { _id: item._id },
      { $set: { batches, ...summary } },
      { new: true, session },
    )
      .lean<LeanInventoryItem>()
      .exec();
    if (!updated) throw new UnknownBatchError(input.batchNumber);

    const [transaction] = await StockTransactionModel.create(
      [
        {
          ...ledgerBase(item),
          action: 'added' satisfies StockAction,
          quantity: input.quantity,
          quantityDelta: input.quantity,
          // Observed, not predicted: the difference matters under concurrency.
          newQuantity: updated.availableQuantity ?? 0,
          previousQuantity: (updated.availableQuantity ?? 0) - input.quantity,
          batchNumber: input.batchNumber,
          expiryDate: input.expiryDate,
          supplier: input.supplier ?? '',
          storageLocation: input.storageLocation ?? '',
          ...contextFields(input),
        },
      ],
      { session },
    );

    // Links the batch back to the receipt that created it, so the item view can show where a
    // container came from. A second update inside the same transaction, because the ledger id
    // does not exist until the row is written.
    await InventoryItemModel.updateOne(
      { _id: item._id, 'batches.batchNumber': input.batchNumber },
      { $set: { 'batches.$.receiptTransactionId': transaction!._id } },
      { session },
    ).exec();

    const finalItem = await InventoryItemModel.findOne({ _id: item._id })
      .session(session)
      .lean<LeanInventoryItem>()
      .exec();

    return {
      item: toRecord(finalItem!),
      transaction: toTransactionRecord(transaction!.toObject() as LeanStockTransaction),
    };
  });
}

export async function issue(input: IssueStockInput): Promise<StockResult> {
  await connectToDatabase();

  return withTransaction(async (session) => {
    const item = await InventoryItemModel.findOne({ _id: oid(input.itemId) })
      .session(session)
      .lean<LeanInventoryItem>()
      .exec();
    if (!item) throw new UnknownBatchError('');

    /**
     * The availability check runs **inside** the transaction, against the value read inside it.
     *
     * That placement is the whole guarantee, and it is worth being precise about why. Two
     * concurrent issues touch the same document, so the second one raises a MongoDB write
     * conflict; `session.withTransaction` retries it, and the retry re-runs this callback from
     * the top — including the `findOne` above. The loser therefore reads the *decremented*
     * quantity and is refused here rather than overwriting the winner.
     *
     * An earlier version leaned on `updateOne` + `arrayFilters` + `modifiedCount === 0` instead.
     * It read correctly and did not work: the driver reports the parent document as matched, and
     * the failure mode was an issue that silently changed nothing and reported success. Checking
     * a value this code has in its hand beats checking a counter whose semantics are the driver's.
     */
    const held = new Map(
      (item.batches ?? []).map((batch) => [batch.batchNumber, batch.quantity]),
    );

    for (const allocation of input.allocations) {
      const available = held.get(allocation.batchNumber) ?? 0;
      if (available < allocation.quantity) {
        throw new InsufficientStockError(available, allocation.quantity, item.unit);
      }
      held.set(allocation.batchNumber, available - allocation.quantity);
    }

    // Fully consumed batches are pruned so the embedded array stays bounded. Nothing is lost:
    // every receipt and issue against them survives in the ledger, which is append-only.
    const remaining = (item.batches ?? [])
      .map((batch) => ({ ...batch, quantity: held.get(batch.batchNumber) ?? batch.quantity }))
      .filter((batch) => batch.quantity > 0);
    const summary = summaryUpdate(
      remaining.map((batch) => ({
        batchNumber: batch.batchNumber,
        quantity: batch.quantity,
        expiryDate: batch.expiryDate ?? null,
      })),
      item.minimumStock ?? 0,
    );

    const updated = await InventoryItemModel.findOneAndUpdate(
      { _id: item._id },
      { $set: { batches: remaining, ...summary } },
      { new: true, session },
    )
      .lean<LeanInventoryItem>()
      .exec();

    const total = input.allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);

    const [transaction] = await StockTransactionModel.create(
      [
        {
          ...ledgerBase(item),
          action: 'issued' satisfies StockAction,
          quantity: total,
          quantityDelta: -total,
          newQuantity: updated!.availableQuantity ?? 0,
          previousQuantity: (updated!.availableQuantity ?? 0) + total,
          // A multi-batch issue records the batches it drew from, comma separated, because a
          // single field cannot hold two and splitting the ledger row would make one physical
          // handover look like two.
          batchNumber: input.allocations.map((allocation) => allocation.batchNumber).join(', '),
          expiryDate: input.allocations[0]?.expiryDate ?? null,
          issuedToType: input.target.type,
          issuedToUserId: optionalOid(input.target.userId),
          issuedToDepartmentId: optionalOid(input.target.departmentId),
          projectId: optionalOid(input.target.projectId),
          experimentId: optionalOid(input.target.experimentId),
          issuedToLabel: input.target.label,
          ...contextFields(input),
        },
      ],
      { session },
    );

    return {
      item: toRecord(updated!),
      transaction: toTransactionRecord(transaction!.toObject() as LeanStockTransaction),
    };
  });
}

export async function adjust(input: AdjustStockInput): Promise<StockResult> {
  await connectToDatabase();

  return withTransaction(async (session) => {
    const item = await InventoryItemModel.findOne({ _id: oid(input.itemId) })
      .session(session)
      .lean<LeanInventoryItem>()
      .exec();
    if (!item) throw new UnknownBatchError(input.batchNumber);

    const batches = (item.batches ?? []).map((batch) => ({ ...batch }));
    const existing = batches.find((batch) => batch.batchNumber === input.batchNumber);

    if (input.delta < 0) {
      if (!existing) throw new UnknownBatchError(input.batchNumber);
      if (existing.quantity < -input.delta) {
        throw new InsufficientStockError(existing.quantity, -input.delta, item.unit);
      }
      existing.quantity += input.delta;
    } else if (existing) {
      existing.quantity += input.delta;
    } else {
      // A recount that finds material the system did not know about is a real outcome, so a
      // positive adjustment may create the batch. It is still a ledger row explaining itself.
      batches.push({
        batchNumber: input.batchNumber,
        quantity: input.delta,
        expiryDate: input.expiryDate ?? null,
        supplier: item.supplier ?? '',
        storageLocation: item.storageLocation ?? '',
        receivedAt: input.performedAt,
        receivedBy: optionalOid(input.performedBy),
        receiptTransactionId: null,
      } as (typeof batches)[number]);
    }

    const remaining = batches.filter((batch) => batch.quantity > 0);
    const summary = summaryUpdate(
      remaining.map((batch) => ({
        batchNumber: batch.batchNumber,
        quantity: batch.quantity,
        expiryDate: batch.expiryDate ?? null,
      })),
      item.minimumStock ?? 0,
    );

    const updated = await InventoryItemModel.findOneAndUpdate(
      { _id: item._id },
      { $set: { batches: remaining, ...summary } },
      { new: true, session },
    )
      .lean<LeanInventoryItem>()
      .exec();

    const [transaction] = await StockTransactionModel.create(
      [
        {
          ...ledgerBase(item),
          action: 'adjusted' satisfies StockAction,
          quantity: Math.abs(input.delta),
          quantityDelta: input.delta,
          newQuantity: updated!.availableQuantity ?? 0,
          previousQuantity: (updated!.availableQuantity ?? 0) - input.delta,
          batchNumber: input.batchNumber,
          expiryDate: input.expiryDate ?? existing?.expiryDate ?? null,
          ...contextFields(input),
          // The reason is mandatory on an adjustment and is stored where an auditor reads it.
          notes: input.notes ? `${input.reason} — ${input.notes}` : input.reason,
        },
      ],
      { session },
    );

    return {
      item: toRecord(updated!),
      transaction: toTransactionRecord(transaction!.toObject() as LeanStockTransaction),
    };
  });
}

export async function expire(input: ExpireStockInput): Promise<StockTransactionRecord[]> {
  await connectToDatabase();

  const candidates = await InventoryItemModel.find({
    organizationId: oid(input.organizationId),
    'batches.expiryDate': { $lt: input.now },
    availableQuantity: { $gt: 0 },
  })
    .lean<LeanInventoryItem[]>()
    .exec();

  const written: StockTransactionRecord[] = [];

  for (const candidate of candidates) {
    /**
     * One transaction per item rather than one for the whole sweep.
     *
     * A single transaction across hundreds of items would abort all of them because one had a
     * concurrent issue in flight, and the sweep would make no progress at all on the next run
     * either. Per item, a conflict costs that item and the rest still get written off.
     */
    const result = await withTransaction(async (session) => {
      const item = await InventoryItemModel.findOne({ _id: candidate._id })
        .session(session)
        .lean<LeanInventoryItem>()
        .exec();
      if (!item) return null;

      const expiredBatches = (item.batches ?? []).filter(
        (batch) => batch.quantity > 0 && batch.expiryDate && batch.expiryDate < input.now,
      );
      if (expiredBatches.length === 0) return null;

      const lost = expiredBatches.reduce((sum, batch) => sum + batch.quantity, 0);
      const remaining = (item.batches ?? []).filter(
        (batch) => !(batch.quantity > 0 && batch.expiryDate && batch.expiryDate < input.now),
      );

      const summary = summaryUpdate(
        remaining.map((batch) => ({
          batchNumber: batch.batchNumber,
          quantity: batch.quantity,
          expiryDate: batch.expiryDate ?? null,
        })),
        item.minimumStock ?? 0,
      );

      const updated = await InventoryItemModel.findOneAndUpdate(
        { _id: item._id },
        { $set: { batches: remaining, ...summary } },
        { new: true, session },
      )
        .lean<LeanInventoryItem>()
        .exec();

      const [transaction] = await StockTransactionModel.create(
        [
          {
            ...ledgerBase(item),
            action: 'expired' satisfies StockAction,
            quantity: lost,
            quantityDelta: -lost,
            newQuantity: updated!.availableQuantity ?? 0,
            previousQuantity: (updated!.availableQuantity ?? 0) + lost,
            batchNumber: expiredBatches.map((batch) => batch.batchNumber).join(', '),
            expiryDate: expiredBatches[0]?.expiryDate ?? null,
            purpose: '',
            notes: 'Written off automatically: past expiry date',
            documentFileIds: [],
            performedBy: optionalOid(input.performedBy),
            performedByName: input.performedByName ?? 'Expiry sweep',
            performedAt: input.now,
            requestId: null,
          },
        ],
        { session },
      );

      return toTransactionRecord(transaction!.toObject() as LeanStockTransaction);
    });

    if (result) written.push(result);
  }

  return written;
}

/* ------------------------------------------------------------------ ledger reads */

export async function listHistory(
  input: ListStockHistoryInput,
): Promise<{ transactions: StockTransactionRecord[]; total: number }> {
  await connectToDatabase();

  const filter: FilterQuery<StockTransactionDocument> = {
    organizationId: oid(input.organizationId),
  };
  if (input.itemId && Types.ObjectId.isValid(input.itemId)) filter.itemId = oid(input.itemId);
  if (input.action) filter.action = input.action;
  if (input.projectId && Types.ObjectId.isValid(input.projectId)) {
    filter.projectId = oid(input.projectId);
  }
  if (input.experimentId && Types.ObjectId.isValid(input.experimentId)) {
    filter.experimentId = oid(input.experimentId);
  }
  if (input.issuedToUserId && Types.ObjectId.isValid(input.issuedToUserId)) {
    filter.issuedToUserId = oid(input.issuedToUserId);
  }
  if (input.performedBy && Types.ObjectId.isValid(input.performedBy)) {
    filter.performedBy = oid(input.performedBy);
  }
  if (input.from || input.to) {
    filter.performedAt = {
      ...(input.from ? { $gte: input.from } : {}),
      ...(input.to ? { $lt: input.to } : {}),
    };
  }

  const skip = (input.page - 1) * input.pageSize;

  const [docs, total] = await Promise.all([
    StockTransactionModel.find(filter)
      .sort({ performedAt: -1, _id: -1 })
      .skip(skip)
      .limit(input.pageSize)
      .lean<LeanStockTransaction[]>()
      .exec(),
    StockTransactionModel.countDocuments(filter).exec(),
  ]);

  return { transactions: docs.map(toTransactionRecord), total };
}

export async function findTransactionById(id: string): Promise<StockTransactionRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectToDatabase();
  const doc = await StockTransactionModel.findOne({ _id: oid(id) })
    .lean<LeanStockTransaction>()
    .exec();
  return doc ? toTransactionRecord(doc) : null;
}

export const mongoInventoryRepository: InventoryRepository = {
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

export { ExpiredBatchError, InsufficientStockError, UnknownBatchError };
