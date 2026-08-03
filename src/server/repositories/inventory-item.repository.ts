import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { InventoryItemModel, type InventoryItemDocument } from '@/server/db/models';
import type { VisibilityFilter } from '@/server/permissions/visibility';
import {
  nearExpiryCutoff,
  type InventoryCategory,
  type InventoryItemStatus,
  type InventoryStockFilter,
  type InventoryUnit,
  type StockState,
} from '@/server/domain/inventory';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export interface InventoryBatchRecord {
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

type LeanInventoryItem = InventoryItemDocument & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

function toBatchRecord(batch: InventoryItemDocument['batches'][number]): InventoryBatchRecord {
  return {
    batchNumber: batch.batchNumber,
    quantity: batch.quantity,
    expiryDate: batch.expiryDate ?? null,
    supplier: batch.supplier ?? '',
    storageLocation: batch.storageLocation ?? '',
    receivedAt: batch.receivedAt ?? new Date(0),
    receivedBy: batch.receivedBy ? String(batch.receivedBy) : null,
    receiptTransactionId: batch.receiptTransactionId ? String(batch.receiptTransactionId) : null,
  };
}

function toRecord(doc: LeanInventoryItem): InventoryItemRecord {
  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    departmentId: doc.departmentId ? String(doc.departmentId) : null,
    name: doc.name,
    code: doc.code,
    category: doc.category as InventoryCategory,
    unit: doc.unit as InventoryUnit,
    description: doc.description ?? '',
    availableQuantity: doc.availableQuantity ?? 0,
    minimumStock: doc.minimumStock ?? 0,
    stockState: doc.stockState as StockState,
    batches: (doc.batches ?? []).map(toBatchRecord),
    batchNumber: doc.batchNumber ?? '',
    expiryDate: doc.expiryDate ?? null,
    storageLocation: doc.storageLocation ?? '',
    supplier: doc.supplier ?? '',
    status: doc.status as InventoryItemStatus,
    documentFileIds: (doc.documentFileIds ?? []).map(String),
    createdBy: String(doc.createdBy),
    updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Turns a search term into a literal, so it can never be a pattern.
 *
 * The search below is a case-insensitive substring match rather than a `$text` query.
 * Item codes and batch numbers are punctuation-heavy identifiers (`CHM-0042`, `LOT/24/B`)
 * and a text index tokenizes them into pieces nobody types; searching for "chm-00" would
 * find nothing. The cost is that the match itself cannot use an index — acceptable because
 * every query is already narrowed to one organization, and a company's catalogue of
 * materials is thousands of rows, not millions.
 *
 * Escaping every metacharacter is what keeps that safe: the resulting expression is a
 * literal string match, so no user input can turn it into a catastrophically backtracking
 * pattern.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

export interface ListInventoryItemsInput {
  /** Produced by inventoryVisibilityFilter — the query is never built without it. */
  visibility: VisibilityFilter;
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

/** The indexed condition behind each filter chip. */
export function stockFilterCondition(
  filter: InventoryStockFilter,
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
    input.visibility as FilterQuery<InventoryItemDocument>,
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
 * Creates the item definition only.
 *
 * `availableQuantity` and `batches` are deliberately absent from the input: an item comes
 * into existence empty and is filled by a receipt, which writes a history row. There is no
 * route through this repository that puts stock on a shelf without recording where it came
 * from.
 */
export async function create(
  input: CreateInventoryItemInput,
  session?: ClientSession,
): Promise<InventoryItemRecord> {
  await connectToDatabase();
  const [doc] = await InventoryItemModel.create(
    [
      {
        organizationId: oid(input.organizationId),
        departmentId: input.departmentId ? oid(input.departmentId) : null,
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
    session ? { session } : undefined,
  );
  return toRecord(doc!.toObject() as LeanInventoryItem);
}

export async function updateById(
  id: string,
  update: Record<string, unknown>,
  session?: ClientSession,
): Promise<InventoryItemRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectToDatabase();
  const query = InventoryItemModel.findOneAndUpdate({ _id: oid(id) }, update, { new: true });
  if (session) query.session(session);
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

/** Counts per stock state for the dashboard, in one round trip. */
export async function countByStockState(
  visibility: VisibilityFilter,
): Promise<Record<StockState, number>> {
  await connectToDatabase();
  const rows = await InventoryItemModel.aggregate<{ _id: StockState; count: number }>([
    { $match: { ...visibility, deletedAt: null } },
    { $group: { _id: '$stockState', count: { $sum: 1 } } },
  ]).exec();

  const out: Record<StockState, number> = { ok: 0, low: 0, out_of_stock: 0 };
  for (const row of rows) out[row._id] = row.count;
  return out;
}

export async function countMatching(
  visibility: VisibilityFilter,
  condition: FilterQuery<InventoryItemDocument>,
): Promise<number> {
  await connectToDatabase();
  return InventoryItemModel.countDocuments({ $and: [visibility, condition] }).exec();
}
