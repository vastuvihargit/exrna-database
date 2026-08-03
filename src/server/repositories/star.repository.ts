import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { StarModel, type StarrableType } from '@/server/db/models';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export interface StarRef {
  entityType: StarrableType;
  entityId: string;
  createdAt: Date;
}

/** Idempotent: starring an already-starred item is a no-op, not a duplicate row. */
export async function add(input: {
  userId: string;
  organizationId: string;
  entityType: StarrableType;
  entityId: string;
}): Promise<void> {
  await connectToDatabase();
  await StarModel.updateOne(
    { userId: oid(input.userId), entityType: input.entityType, entityId: oid(input.entityId) },
    { $setOnInsert: { organizationId: oid(input.organizationId), createdAt: new Date() } },
    { upsert: true },
  ).exec();
}

export async function remove(input: {
  userId: string;
  entityType: StarrableType;
  entityId: string;
}): Promise<void> {
  await connectToDatabase();
  await StarModel.deleteOne({
    userId: oid(input.userId),
    entityType: input.entityType,
    entityId: oid(input.entityId),
  }).exec();
}

/**
 * Which of these ids the viewer has starred.
 *
 * Returned as a Set so a listing can annotate hundreds of rows without a query each.
 */
export async function starredIdsAmong(
  userId: string,
  entityType: StarrableType,
  entityIds: string[],
): Promise<Set<string>> {
  if (entityIds.length === 0) return new Set();
  await connectToDatabase();
  const docs = await StarModel.find({
    userId: oid(userId),
    entityType,
    entityId: { $in: entityIds.map(oid) },
  })
    .select({ entityId: 1 })
    .lean<Array<{ entityId: Types.ObjectId }>>()
    .exec();
  return new Set(docs.map((doc) => String(doc.entityId)));
}

export async function listForUser(
  userId: string,
  options: { entityType?: StarrableType; limit?: number } = {},
): Promise<StarRef[]> {
  await connectToDatabase();
  const filter: Record<string, unknown> = { userId: oid(userId) };
  if (options.entityType) filter.entityType = options.entityType;

  const docs = await StarModel.find(filter)
    .sort({ createdAt: -1 })
    .limit(options.limit ?? 200)
    .lean<Array<{ entityType: StarrableType; entityId: Types.ObjectId; createdAt: Date }>>()
    .exec();

  return docs.map((doc) => ({
    entityType: doc.entityType,
    entityId: String(doc.entityId),
    createdAt: doc.createdAt,
  }));
}

/** Called when an item is purged, so stars do not point at nothing. */
export async function removeAllFor(entityType: StarrableType, entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;
  await connectToDatabase();
  await StarModel.deleteMany({ entityType, entityId: { $in: entityIds.map(oid) } }).exec();
}
