import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { RecentItemModel, type RecentEntityType } from '@/server/db/models';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export interface RecentRef {
  entityType: RecentEntityType;
  entityId: string;
  lastAction: string;
  lastAccessedAt: Date;
}

/**
 * Records an access. Upsert rather than insert: "recent" is a set of items ordered by
 * last touch, not a log — a user who opens the same folder fifty times should not push
 * everything else out of their recent list.
 */
export async function touch(input: {
  userId: string;
  organizationId: string;
  entityType: RecentEntityType;
  entityId: string;
  action?: string;
}): Promise<void> {
  await connectToDatabase();
  await RecentItemModel.updateOne(
    { userId: oid(input.userId), entityType: input.entityType, entityId: oid(input.entityId) },
    {
      $set: { lastAccessedAt: new Date(), lastAction: input.action ?? 'opened' },
      $setOnInsert: { organizationId: oid(input.organizationId) },
    },
    { upsert: true },
  ).exec();
}

export async function listForUser(
  userId: string,
  options: { entityType?: RecentEntityType; limit?: number } = {},
): Promise<RecentRef[]> {
  await connectToDatabase();
  const filter: Record<string, unknown> = { userId: oid(userId) };
  if (options.entityType) filter.entityType = options.entityType;

  const docs = await RecentItemModel.find(filter)
    .sort({ lastAccessedAt: -1 })
    .limit(options.limit ?? 50)
    .lean<
      Array<{
        entityType: RecentEntityType;
        entityId: Types.ObjectId;
        lastAction: string;
        lastAccessedAt: Date;
      }>
    >()
    .exec();

  return docs.map((doc) => ({
    entityType: doc.entityType,
    entityId: String(doc.entityId),
    lastAction: doc.lastAction,
    lastAccessedAt: doc.lastAccessedAt,
  }));
}

export async function removeAllFor(
  entityType: RecentEntityType,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  await connectToDatabase();
  await RecentItemModel.deleteMany({ entityType, entityId: { $in: entityIds.map(oid) } }).exec();
}
