import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { SavedSearchModel, type SavedSearchDocument } from '@/server/db/models';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

function isValidId(value: string): boolean {
  return Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value);
}

export interface SavedSearchRecord {
  id: string;
  userId: string;
  name: string;
  criteria: Record<string, unknown>;
  isPinned: boolean;
  lastRunAt: Date | null;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
}

type LeanSavedSearch = SavedSearchDocument & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(doc: LeanSavedSearch): SavedSearchRecord {
  return {
    id: String(doc._id),
    userId: String(doc.userId),
    name: doc.name,
    criteria: (doc.criteria as Record<string, unknown>) ?? {},
    isPinned: Boolean(doc.isPinned),
    lastRunAt: doc.lastRunAt ?? null,
    runCount: doc.runCount ?? 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function listForUser(userId: string): Promise<SavedSearchRecord[]> {
  await connectToDatabase();
  const docs = await SavedSearchModel.find({ userId: oid(userId) })
    .sort({ isPinned: -1, updatedAt: -1 })
    .limit(100)
    .lean<LeanSavedSearch[]>()
    .exec();
  return docs.map(toRecord);
}

/**
 * Scoped by user id as well as document id on purpose. A saved search is private, and
 * "find by id then check the owner" is one forgotten check away from an IDOR — this
 * shape has nowhere to forget it.
 */
export async function findOwned(
  userId: string,
  id: string,
): Promise<SavedSearchRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const doc = await SavedSearchModel.findOne({ _id: oid(id), userId: oid(userId) })
    .lean<LeanSavedSearch>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function upsert(input: {
  organizationId: string;
  userId: string;
  name: string;
  criteria: Record<string, unknown>;
  isPinned?: boolean;
}): Promise<SavedSearchRecord> {
  await connectToDatabase();
  const doc = await SavedSearchModel.findOneAndUpdate(
    { userId: oid(input.userId), nameLower: input.name.toLowerCase() },
    {
      $set: {
        organizationId: oid(input.organizationId),
        userId: oid(input.userId),
        name: input.name,
        nameLower: input.name.toLowerCase(),
        criteria: input.criteria,
        ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )
    .lean<LeanSavedSearch>()
    .exec();
  return toRecord(doc);
}

export async function update(
  userId: string,
  id: string,
  changes: { name?: string; isPinned?: boolean },
): Promise<SavedSearchRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const set: Record<string, unknown> = {};
  if (changes.name !== undefined) {
    set.name = changes.name;
    set.nameLower = changes.name.toLowerCase();
  }
  if (changes.isPinned !== undefined) set.isPinned = changes.isPinned;
  if (Object.keys(set).length === 0) return findOwned(userId, id);

  const doc = await SavedSearchModel.findOneAndUpdate(
    { _id: oid(id), userId: oid(userId) },
    { $set: set },
    { new: true },
  )
    .lean<LeanSavedSearch>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function remove(userId: string, id: string): Promise<boolean> {
  if (!isValidId(id)) return false;
  await connectToDatabase();
  const result = await SavedSearchModel.deleteOne({ _id: oid(id), userId: oid(userId) }).exec();
  return (result.deletedCount ?? 0) > 0;
}

/** Fire-and-forget usage counter — never blocks returning results. */
export async function markRun(userId: string, id: string): Promise<void> {
  if (!isValidId(id)) return;
  await connectToDatabase();
  await SavedSearchModel.updateOne(
    { _id: oid(id), userId: oid(userId) },
    { $set: { lastRunAt: new Date() }, $inc: { runCount: 1 } },
  ).exec();
}
