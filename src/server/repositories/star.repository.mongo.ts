/**
 * The MongoDB star repository.
 *
 * A faithful move of the implementation that has always served production, behind the
 * contract. No behaviour is changed here: the ids reaching these methods have already been
 * through an authorized lookup, and Mongo ObjectIds are preserved as D1 TEXT identifiers by
 * the migration, so both engines see the same id shapes.
 */
import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { StarModel } from '@/server/db/models';
import type {
  AddStarInput,
  RemoveStarInput,
  StarRef,
  StarRepository,
  StarrableType,
} from './star.repository.contract';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export async function add(input: AddStarInput): Promise<void> {
  await connectToDatabase();
  await StarModel.updateOne(
    { userId: oid(input.userId), entityType: input.entityType, entityId: oid(input.entityId) },
    { $setOnInsert: { organizationId: oid(input.organizationId), createdAt: new Date() } },
    { upsert: true },
  ).exec();
}

export async function remove(input: RemoveStarInput): Promise<void> {
  await connectToDatabase();
  await StarModel.deleteOne({
    userId: oid(input.userId),
    entityType: input.entityType,
    entityId: oid(input.entityId),
  }).exec();
}

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

export async function removeAllFor(
  entityType: StarrableType,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  await connectToDatabase();
  await StarModel.deleteMany({ entityType, entityId: { $in: entityIds.map(oid) } }).exec();
}

export const mongoStarRepository: StarRepository = {
  add,
  remove,
  starredIdsAmong,
  listForUser,
  removeAllFor,
};
