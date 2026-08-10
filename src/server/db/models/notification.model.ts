/**
 * A message addressed to one employee.
 *
 * Deliberately one row per *recipient*, not one row per event with a recipient list.
 * Read state, dismissal and retention are all per-person, and a shared row would mean
 * one reader's action changing what everyone else sees.
 *
 * A notification carries a label, never content. "Alice commented on
 * Tox-Study-Protocol.pdf" tells the recipient enough to decide whether to click; the
 * comment body stays behind the permission check on the file. Recipients are chosen at
 * send time by the sending service, which is the layer that knows whether the recipient
 * can see the thing at all.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';

export const NOTIFICATION_TYPES = [
  'share.received',
  'comment.added',
  'comment.mention',
  'comment.reply',
  'review.requested',
  'review.decided',
  /** An approved document changed and has gone back to needing review. */
  'review.reopened',
  'version.uploaded',
  'quota.warning',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const notificationSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    /** The recipient. Every query is scoped by this. */
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    type: { type: String, enum: NOTIFICATION_TYPES, required: true },

    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: '', maxlength: 200 },

    entityType: { type: String, required: true, maxlength: 40 },
    entityId: { type: Schema.Types.ObjectId, required: true },
    /** The file or folder name, denormalized so the list renders without a join. */
    entityLabel: { type: String, default: '', maxlength: 300 },

    message: { type: String, required: true, maxlength: 500 },

    readAt: { type: Date, default: null },

    /**
     * Set only by paths whose delivery is at-least-once — today, Queue consumers.
     *
     * The sparse unique index below is what makes a redelivery a no-op rather than a duplicate
     * row in somebody's bell menu. Rows written inline from a request carry null: there is no
     * retry to deduplicate, and a shared key would collapse two genuinely separate events (the
     * same person sharing the same file with you twice) into one.
     */
    dedupeKey: { type: String, default: null, maxlength: 200 },
  },
  baseSchemaOptions,
);

// The unread badge and the list are the same query shape; this index serves both.
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ entityType: 1, entityId: 1 });
/**
 * Partial, not sparse.
 *
 * `sparse: true` excludes documents where the field is *absent*. It does not exclude documents
 * where the field is present and null — and every notification written by an inline path stores
 * an explicit `dedupeKey: null`, because the schema gives it that default. A sparse unique index
 * therefore indexes all of them, decides they are all the same key, and rejects the second
 * notification anybody ever receives.
 *
 * `partialFilterExpression` on `$type: 'string'` indexes only the rows that carry a real key,
 * which is what the D1 side expresses as `WHERE dedupe_key IS NOT NULL`.
 *
 * This index is the deduplication — not a `findOne` in the repository, which would be a
 * read-then-write race between two concurrent redeliveries of the same message.
 */
notificationSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);

export type NotificationDocument = InferSchemaType<typeof notificationSchema>;

export const NotificationModel: Model<NotificationDocument> =
  (models.Notification as Model<NotificationDocument>) ??
  model<NotificationDocument>('Notification', notificationSchema);
