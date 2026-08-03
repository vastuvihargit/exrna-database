/**
 * An inventory item — one material the laboratory keeps in stock.
 *
 * The item is the *definition* (what it is, where it lives, who supplies it, when to
 * reorder). What is physically on the shelf is the `batches` array: each entry is a
 * delivery with its own batch number, quantity and expiry date.
 *
 * ── Why batches are embedded rather than a collection of their own ──────────────────
 *
 * "Expired stock must not be issued" cannot be answered from a single quantity: 500 g in
 * stock says nothing about how much of it expired last week. Per-batch quantities are
 * therefore forced by the requirement, not chosen for elegance.
 *
 * Keeping them inside the item document means the availability check and the decrement
 * are one atomic `findOneAndUpdate` — the filter carries `quantity: { $gte: n }`, so a
 * concurrent issue that would overdraw simply matches nothing. There is no read-then-write
 * window in which two requests can both believe there is enough. A separate collection
 * would need a transaction for every such check and would still leave that window open
 * between the read and the write.
 *
 * The price is a bounded array, so it is bounded explicitly (MAX_BATCHES_PER_ITEM) and
 * consumed batches are pruned. Nothing is lost when they are: `stockTransactions` is the
 * permanent record of every receipt and issue, and it is append-only.
 *
 * `availableQuantity`, `stockState`, `batchNumber` and `expiryDate` are derived from
 * `batches` and rewritten in the same update. They exist so that listing, filtering and
 * alerting can use an index; they are never the source of truth.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { applySoftDeleteFilter, baseSchemaOptions, softDeleteFields } from '@/server/db/base-schema';
import {
  INVENTORY_CATEGORIES,
  INVENTORY_ITEM_STATUSES,
  INVENTORY_UNITS,
  STOCK_STATES,
} from '@/server/domain/inventory';

/**
 * `_id: false` — a batch is keyed by its batch number within its item, which is what a
 * store manager reads off the label. A second, synthetic identifier would be one more
 * thing that can disagree with the physical container.
 */
const batchSchema = new Schema(
  {
    batchNumber: { type: String, required: true, trim: true, maxlength: 80 },
    quantity: { type: Number, required: true, min: 0 },
    expiryDate: { type: Date, default: null },
    supplier: { type: String, default: '', trim: true, maxlength: 200 },
    storageLocation: { type: String, default: '', trim: true, maxlength: 120 },
    receivedAt: { type: Date, default: Date.now },
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** The receipt that created this batch, so the item view can link back to it. */
    receiptTransactionId: { type: Schema.Types.ObjectId, ref: 'StockTransaction', default: null },
  },
  { _id: false },
);

const inventoryItemSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    /**
     * The custodian department. `null` means a central store.
     *
     * This is what a department-scoped role grant is matched against when someone tries to
     * change stock (see inventory-access.ts). Reading is organization-wide — stock levels
     * are operational data, like the department list and the employee directory.
     */
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    /** Human-facing identifier printed on the shelf label, e.g. `CHM-0042`. */
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 60 },
    category: { type: String, enum: INVENTORY_CATEGORIES, required: true },
    unit: { type: String, enum: INVENTORY_UNITS, required: true },
    description: { type: String, default: '', maxlength: 4000 },

    /** Derived: the sum of `batches[].quantity`. Never written directly by a route. */
    availableQuantity: { type: Number, default: 0, min: 0 },
    minimumStock: { type: Number, default: 0, min: 0 },
    /** Derived from availableQuantity and minimumStock. */
    stockState: { type: String, enum: STOCK_STATES, default: 'out_of_stock' },

    batches: { type: [batchSchema], default: [] },
    /** Derived: the batch that should be issued next (first expiry first out). */
    batchNumber: { type: String, default: '', trim: true, maxlength: 80 },
    /** Derived: the earliest expiry date among batches that still hold stock. */
    expiryDate: { type: Date, default: null },

    /** Defaults offered when receiving stock; a receipt may override either. */
    storageLocation: { type: String, default: '', trim: true, maxlength: 120 },
    supplier: { type: String, default: '', trim: true, maxlength: 200 },

    status: { type: String, enum: INVENTORY_ITEM_STATUSES, default: 'active' },

    /**
     * Certificates of analysis, safety data sheets, delivery notes.
     *
     * Ids of rows in the existing `files` collection — inventory stores no bytes of its
     * own and never touches the storage layer. Resolving one goes through the file
     * service, so its permissions apply unchanged.
     */
    documentFileIds: { type: [Schema.Types.ObjectId], ref: 'File', default: [] },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    ...softDeleteFields,
  },
  baseSchemaOptions,
);

applySoftDeleteFilter(inventoryItemSchema);

/**
 * Codes are unique per organization and permanent.
 *
 * The uniqueness deliberately survives a soft delete: the code is printed on the shelf and
 * quoted in every historic transaction row, so reusing it for a different material would
 * make the ledger ambiguous. An item that is no longer stocked is set to `inactive` and can
 * be brought back — which is why that status exists.
 */
inventoryItemSchema.index({ organizationId: 1, code: 1 }, { unique: true });
inventoryItemSchema.index({ organizationId: 1, status: 1, category: 1 });
inventoryItemSchema.index({ organizationId: 1, departmentId: 1, status: 1 });
inventoryItemSchema.index({ organizationId: 1, stockState: 1 });
inventoryItemSchema.index({ organizationId: 1, expiryDate: 1 });
inventoryItemSchema.index({ organizationId: 1, 'batches.expiryDate': 1 });
inventoryItemSchema.index({ organizationId: 1, name: 1 });

export type InventoryBatchDocument = InferSchemaType<typeof batchSchema>;
export type InventoryItemDocument = InferSchemaType<typeof inventoryItemSchema>;

export const InventoryItemModel: Model<InventoryItemDocument> =
  (models.InventoryItem as Model<InventoryItemDocument>) ??
  model<InventoryItemDocument>('InventoryItem', inventoryItemSchema);
