/**
 * The MongoDB recent-items repository — a faithful move behind the contract.
 */
import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { RecentItemModel } from '@/server/db/models';
import type {
  RecentEntityType,
  RecentItemRepository,
  RecentRef,
  TouchRecentInput,
} from './recent-item.repository.contract';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export async function touch(input: TouchRecentInput): Promise<void> {
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

export const mongoRecentItemRepository: RecentItemRepository = {
  touch,
  listForUser,
  removeAllFor,
};
