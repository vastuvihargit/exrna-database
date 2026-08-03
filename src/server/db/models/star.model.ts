/**
 * Starred items.
 *
 * A star belongs to the person who set it, not to the resource — otherwise one
 * employee starring a shared protocol would star it for the whole department. The
 * `isStarred` flag in the API responses is derived per viewer from this collection.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

export const STARRABLE_TYPES = ['folder', 'file'] as const;
export type StarrableType = (typeof STARRABLE_TYPES)[number];

const starSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    entityType: { type: String, enum: STARRABLE_TYPES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
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

/** Starring twice is a no-op rather than a second row. */
starSchema.index({ userId: 1, entityType: 1, entityId: 1 }, { unique: true });
starSchema.index({ userId: 1, createdAt: -1 });

export type StarDocument = InferSchemaType<typeof starSchema>;

export const StarModel: Model<StarDocument> =
  (models.Star as Model<StarDocument>) ?? model<StarDocument>('Star', starSchema);
