/**
 * The stock ledger — every movement of every item, and the stock history the UI reads.
 *
 * "Stock transaction" and "stock history" are the same rows read two ways: a transaction
 * is what you write when stock moves, the history is what you get when you read them back
 * for one item or for the whole store.
 *
 * ── Immutability ────────────────────────────────────────────────────────────────────
 *
 * The brief requires that normal users cannot edit or delete stock history. That is
 * enforced in three layers, the same three that protect the audit log:
 *   1. the repository exposes only append() and query functions
 *   2. the pre-hooks below reject every update and delete on the model, for everyone
 *   3. no route exists that could reach one — there is no PATCH and no DELETE
 *
 * Layer 2 makes it a property of the data rather than of the code that happens to be
 * calling: a future service that tries to "fix" a row fails loudly instead of quietly
 * rewriting history. A mistaken entry is corrected by a compensating `adjusted` row, which
 * is how a stock ledger is supposed to work and leaves the correction visible.
 *
 * There are deliberately no soft-delete fields: nothing here may be removed.
 *
 * `previousQuantity` and `newQuantity` are recorded rather than recomputed by replaying the
 * ledger. They are what makes a single row self-explanatory to an auditor, and they are the
 * check that the item's own counter never drifted.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

export const STOCK_ACTIONS = ['added', 'issued', 'returned', 'adjusted', 'expired'] as const;
export type StockAction = (typeof STOCK_ACTIONS)[number];

/** Who or what stock was issued to. */
export const STOCK_ISSUE_TARGETS = ['employee', 'department', 'project', 'experiment'] as const;
export type StockIssueTarget = (typeof STOCK_ISSUE_TARGETS)[number];

const stockTransactionSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    itemId: { type: Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
    /** Denormalized so history renders without a join, and survives the item being renamed. */
    itemCode: { type: String, required: true, maxlength: 60 },
    itemName: { type: String, required: true, maxlength: 200 },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },

    action: { type: String, enum: STOCK_ACTIONS, required: true },
    /** The magnitude as entered by the user, always positive. */
    quantity: { type: Number, required: true, min: 0 },
    /** Signed: positive for added/returned, negative for issued/expired, either for adjusted. */
    quantityDelta: { type: Number, required: true },
    previousQuantity: { type: Number, required: true, min: 0 },
    newQuantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, maxlength: 20 },

    batchNumber: { type: String, default: '', trim: true, maxlength: 80 },
    expiryDate: { type: Date, default: null },
    supplier: { type: String, default: '', trim: true, maxlength: 200 },
    storageLocation: { type: String, default: '', trim: true, maxlength: 120 },

    issuedToType: { type: String, enum: STOCK_ISSUE_TARGETS, default: null },
    issuedToUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    issuedToDepartmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    experimentId: { type: Schema.Types.ObjectId, ref: 'Experiment', default: null },
    /** Denormalized label of the issue target, so history reads without four lookups. */
    issuedToLabel: { type: String, default: '', maxlength: 300 },

    purpose: { type: String, default: '', maxlength: 500 },
    notes: { type: String, default: '', maxlength: 2000 },
    /** Delivery notes and certificates — existing drive files, referenced not copied. */
    documentFileIds: { type: [Schema.Types.ObjectId], ref: 'File', default: [] },

    /** The person who received, issued or adjusted. `null` only for the expiry sweep. */
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    performedByName: { type: String, default: '', maxlength: 200 },
    /** The received / issue date, which may be backdated by the user. */
    performedAt: { type: Date, required: true },
    /** Ties this row to its audit-log entry and to the request that produced it. */
    requestId: { type: String, default: null, maxlength: 64 },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    minimize: false,
    strict: 'throw',
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  },
);

stockTransactionSchema.index({ organizationId: 1, createdAt: -1 });
stockTransactionSchema.index({ itemId: 1, createdAt: -1 });
stockTransactionSchema.index({ organizationId: 1, action: 1, createdAt: -1 });
stockTransactionSchema.index({ performedBy: 1, createdAt: -1 });
stockTransactionSchema.index({ projectId: 1, createdAt: -1 }, { sparse: true });
stockTransactionSchema.index({ experimentId: 1, createdAt: -1 }, { sparse: true });
stockTransactionSchema.index({ issuedToUserId: 1, createdAt: -1 }, { sparse: true });
stockTransactionSchema.index({ organizationId: 1, batchNumber: 1 });

const IMMUTABLE = 'Stock history is append-only and cannot be modified or deleted';

for (const hook of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'] as const) {
  stockTransactionSchema.pre(hook, function blockUpdate(next) {
    next(new Error(IMMUTABLE));
  });
}
for (const hook of ['deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  stockTransactionSchema.pre(hook, function blockDelete(next) {
    next(new Error(IMMUTABLE));
  });
}
stockTransactionSchema.pre('save', function blockResave(next) {
  if (!this.isNew) {
    next(new Error(IMMUTABLE));
    return;
  }
  next();
});

export type StockTransactionDocument = InferSchemaType<typeof stockTransactionSchema>;

export const StockTransactionModel: Model<StockTransactionDocument> =
  (models.StockTransaction as Model<StockTransactionDocument>) ??
  model<StockTransactionDocument>('StockTransaction', stockTransactionSchema);
