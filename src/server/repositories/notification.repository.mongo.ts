/**
 * The MongoDB notification repository — the existing implementation, moved behind the contract.
 *
 * The one behavioural addition is `dedupeKey`, which needs a sparse unique index on the model to
 * mean anything. `create` translates the resulting duplicate-key error into a no-op, because to
 * the caller "this notification already exists" is success — the whole point of the key is that a
 * Queue redelivery should be indistinguishable from a first delivery.
 *
 * Error code 11000 is caught rather than pre-checked deliberately: a `findOne` followed by an
 * `insert` is the read-then-write race the key exists to close.
 */
import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { NotificationModel, type NotificationDocument } from '@/server/db/models';
import {
  DEFAULT_NOTIFICATION_PAGE,
  MAX_NOTIFICATION_PAGE,
  type CreateNotificationInput,
  type NotificationRecord,
  type NotificationRepository,
  type NotificationType,
} from './notification.repository.contract';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

function isValidId(value: string): boolean {
  return Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value);
}

type LeanNotification = NotificationDocument & { _id: Types.ObjectId; createdAt: Date };

function toRecord(doc: LeanNotification): NotificationRecord {
  return {
    id: String(doc._id),
    type: doc.type as NotificationType,
    actorUserId: doc.actorUserId ? String(doc.actorUserId) : null,
    actorName: doc.actorName ?? '',
    entityType: doc.entityType,
    entityId: String(doc.entityId),
    entityLabel: doc.entityLabel ?? '',
    message: doc.message,
    readAt: doc.readAt ?? null,
    createdAt: doc.createdAt,
  };
}

function toDocument(input: CreateNotificationInput): Record<string, unknown> {
  return {
    organizationId: oid(input.organizationId),
    userId: oid(input.userId),
    type: input.type,
    actorUserId: input.actorUserId ? oid(input.actorUserId) : null,
    actorName: input.actorName ?? '',
    entityType: input.entityType,
    entityId: oid(input.entityId),
    entityLabel: input.entityLabel ?? '',
    message: input.message,
    dedupeKey: input.dedupeKey ?? null,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

export async function create(input: CreateNotificationInput): Promise<void> {
  await connectToDatabase();
  try {
    await NotificationModel.create(toDocument(input));
  } catch (error) {
    // A redelivery of an event already recorded. Success from the caller's point of view.
    if (input.dedupeKey && isDuplicateKey(error)) return;
    throw error;
  }
}

export async function createMany(inputs: CreateNotificationInput[]): Promise<void> {
  if (inputs.length === 0) return;
  await connectToDatabase();
  try {
    // `ordered: false` so one duplicate in a fan-out does not stop the rest being written.
    await NotificationModel.insertMany(inputs.map(toDocument), { ordered: false });
  } catch (error) {
    if (inputs.some((input) => input.dedupeKey) && isDuplicateKey(error)) return;
    throw error;
  }
}

export async function listForUser(
  userId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationRecord[]> {
  await connectToDatabase();
  const filter: Record<string, unknown> = { userId: oid(userId) };
  if (options.unreadOnly) filter.readAt = null;

  const docs = await NotificationModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(options.limit ?? DEFAULT_NOTIFICATION_PAGE, MAX_NOTIFICATION_PAGE))
    .lean<LeanNotification[]>()
    .exec();
  return docs.map(toRecord);
}

export async function countUnread(userId: string): Promise<number> {
  await connectToDatabase();
  return NotificationModel.countDocuments({ userId: oid(userId), readAt: null }).exec();
}

export async function markRead(userId: string, notificationId: string): Promise<boolean> {
  if (!isValidId(notificationId)) return false;
  await connectToDatabase();
  const result = await NotificationModel.updateOne(
    { _id: oid(notificationId), userId: oid(userId), readAt: null },
    { $set: { readAt: new Date() } },
  ).exec();
  return result.matchedCount > 0;
}

export async function markAllRead(userId: string): Promise<number> {
  await connectToDatabase();
  const result = await NotificationModel.updateMany(
    { userId: oid(userId), readAt: null },
    { $set: { readAt: new Date() } },
  ).exec();
  return result.modifiedCount;
}

export async function purgeForEntities(entityIds: string[]): Promise<number> {
  const valid = entityIds.filter(isValidId).map(oid);
  if (valid.length === 0) return 0;
  await connectToDatabase();
  const result = await NotificationModel.deleteMany({ entityId: { $in: valid } }).exec();
  return result.deletedCount ?? 0;
}

export const mongoNotificationRepository: NotificationRepository = {
  create,
  createMany,
  listForUser,
  countUnread,
  markRead,
  markAllRead,
  purgeForEntities,
};
