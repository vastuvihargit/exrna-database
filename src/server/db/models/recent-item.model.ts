/**
 * "Recent" — one row per (user, item), upserted on access.
 *
 * Derived from the activity feed in principle, but stored separately on purpose: a
 * $group over an ever-growing activity collection to find each user's last twenty items
 * is the query that quietly stops finishing once the collection is large.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

export const RECENT_ENTITY_TYPES = ['folder', 'file'] as const;
export type RecentEntityType = (typeof RECENT_ENTITY_TYPES)[number];

const recentItemSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    entityType: { type: String, enum: RECENT_ENTITY_TYPES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    /** `opened` | `edited` | `uploaded` — what the user last did with it. */
    lastAction: { type: String, default: 'opened', maxlength: 40 },
    lastAccessedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: false,
    versionKey: false,
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

recentItemSchema.index({ userId: 1, entityType: 1, entityId: 1 }, { unique: true });
recentItemSchema.index({ userId: 1, lastAccessedAt: -1 });

export type RecentItemDocument = InferSchemaType<typeof recentItemSchema>;

export const RecentItemModel: Model<RecentItemDocument> =
  (models.RecentItem as Model<RecentItemDocument>) ??
  model<RecentItemDocument>('RecentItem', recentItemSchema);
