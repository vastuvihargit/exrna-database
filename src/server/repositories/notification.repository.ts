import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import {
  NotificationModel,
  type NotificationDocument,
  type NotificationType,
} from '@/server/db/models';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

function isValidId(value: string): boolean {
  return Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value);
}

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  actorUserId: string | null;
  actorName: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  message: string;
  readAt: Date | null;
  createdAt: Date;
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

export interface CreateNotificationInput {
  organizationId: string;
  userId: string;
  type: NotificationType;
  actorUserId?: string | null;
  actorName?: string;
  entityType: string;
  entityId: string;
  entityLabel?: string;
  message: string;
}

export async function create(input: CreateNotificationInput): Promise<void> {
  await connectToDatabase();
  await NotificationModel.create({
    organizationId: oid(input.organizationId),
    userId: oid(input.userId),
    type: input.type,
    actorUserId: input.actorUserId ? oid(input.actorUserId) : null,
    actorName: input.actorName ?? '',
    entityType: input.entityType,
    entityId: oid(input.entityId),
    entityLabel: input.entityLabel ?? '',
    message: input.message,
  });
}

/** Bulk insert for a fan-out (review requests to several reviewers). */
export async function createMany(inputs: CreateNotificationInput[]): Promise<void> {
  if (inputs.length === 0) return;
  await connectToDatabase();
  await NotificationModel.insertMany(
    inputs.map((input) => ({
      organizationId: oid(input.organizationId),
      userId: oid(input.userId),
      type: input.type,
      actorUserId: input.actorUserId ? oid(input.actorUserId) : null,
      actorName: input.actorName ?? '',
      entityType: input.entityType,
      entityId: oid(input.entityId),
      entityLabel: input.entityLabel ?? '',
      message: input.message,
    })),
    { ordered: false },
  );
}

/**
 * Every read is scoped by `userId`, which is the whole access-control story for this
 * collection: there is no function here that can return another person's notifications.
 */
export async function listForUser(
  userId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationRecord[]> {
  await connectToDatabase();
  const filter: Record<string, unknown> = { userId: oid(userId) };
  if (options.unreadOnly) filter.readAt = null;

  const docs = await NotificationModel.find(filter)
    .sort({ createdAt: -1 })
    .limit(Math.min(options.limit ?? 50, 100))
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

/**
 * Removes notifications pointing at an entity that no longer exists.
 *
 * Called when a file is purged. A notification that outlives its subject is a dangling
 * reference to a name the recipient can no longer verify — and, once the id is gone,
 * potentially to a *different* file if ids were ever reused.
 */
export async function purgeForEntities(entityIds: string[]): Promise<number> {
  const valid = entityIds.filter(isValidId).map(oid);
  if (valid.length === 0) return 0;
  await connectToDatabase();
  const result = await NotificationModel.deleteMany({ entityId: { $in: valid } }).exec();
  return result.deletedCount ?? 0;
}
