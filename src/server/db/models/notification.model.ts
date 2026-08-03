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
  },
  baseSchemaOptions,
);

// The unread badge and the list are the same query shape; this index serves both.
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ entityType: 1, entityId: 1 });

export type NotificationDocument = InferSchemaType<typeof notificationSchema>;

export const NotificationModel: Model<NotificationDocument> =
  (models.Notification as Model<NotificationDocument>) ??
  model<NotificationDocument>('Notification', notificationSchema);
