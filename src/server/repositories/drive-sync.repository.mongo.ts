/**
 * The MongoDB Drive-sync cursor repository.
 *
 * Unchanged in behaviour from the version that has been running; what moved is the signature.
 * `updateState` took a raw `{ $set, $inc }` document and now takes the closed field set the
 * contract declares, so the two engines cannot be handed different things — and so nothing can
 * write `startPageToken` through a path that skips the conditional guard.
 */
import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { DriveSyncStateModel } from '@/server/db/models/drive-sync-state.model';
import type {
  AdvanceCursorInput,
  DriveSyncRepository,
  DriveSyncRunState,
  DriveSyncStateRecord,
  DriveSyncStateUpdate,
} from './drive-sync.repository.contract';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

function toRecord(doc: Record<string, unknown>): DriveSyncStateRecord {
  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    sharedDriveId: String(doc.sharedDriveId),
    state: (doc.state as DriveSyncRunState) ?? 'idle',
    startPageToken: (doc.startPageToken as string | null) ?? null,
    tokenExpiredAt: (doc.tokenExpiredAt as Date | null) ?? null,
    lastPollAt: (doc.lastPollAt as Date | null) ?? null,
    lastSuccessfulPollAt: (doc.lastSuccessfulPollAt as Date | null) ?? null,
    lastFullReconcileAt: (doc.lastFullReconcileAt as Date | null) ?? null,
    changesApplied: (doc.changesApplied as number) ?? 0,
    conflictsDetected: (doc.conflictsDetected as number) ?? 0,
    consecutiveFailures: (doc.consecutiveFailures as number) ?? 0,
    lastError: (doc.lastError as string | null) ?? null,
    updatedAt: (doc.updatedAt as Date) ?? new Date(0),
  };
}

/**
 * The cursor document, created if this is the first time this drive has been synchronized.
 *
 * An upsert rather than find-then-create: two workers starting at the same moment would
 * otherwise each create one, and the unique index would fail the second — turning a harmless
 * race into a failed sync run.
 */
export async function ensureState(input: {
  organizationId: string;
  sharedDriveId: string;
}): Promise<DriveSyncStateRecord> {
  await connectToDatabase();

  const doc = await DriveSyncStateModel.findOneAndUpdate(
    { organizationId: oid(input.organizationId), sharedDriveId: input.sharedDriveId },
    { $setOnInsert: { state: 'idle' } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )
    .lean<Record<string, unknown>>()
    .exec();

  return toRecord(doc!);
}

export async function findState(input: {
  organizationId: string;
  sharedDriveId: string;
}): Promise<DriveSyncStateRecord | null> {
  await connectToDatabase();
  const doc = await DriveSyncStateModel.findOne({
    organizationId: oid(input.organizationId),
    sharedDriveId: input.sharedDriveId,
  })
    .lean<Record<string, unknown>>()
    .exec();
  return doc ? toRecord(doc) : null;
}

/** Every drive's cursor. The admin monitoring view; there is normally exactly one. */
export async function listStates(): Promise<DriveSyncStateRecord[]> {
  await connectToDatabase();
  const docs = await DriveSyncStateModel.find({})
    .sort({ updatedAt: -1 })
    .lean<Array<Record<string, unknown>>>()
    .exec();
  return docs.map(toRecord);
}

export async function updateState(id: string, update: DriveSyncStateUpdate): Promise<void> {
  await connectToDatabase();

  const set: Record<string, unknown> = {};
  for (const key of [
    'state',
    'startPageToken',
    'tokenExpiredAt',
    'lastPollAt',
    'lastSuccessfulPollAt',
    'lastFullReconcileAt',
    'lastError',
    'consecutiveFailures',
  ] as const) {
    if (update[key] !== undefined) set[key] = update[key];
  }

  const document: Record<string, unknown> = {};
  if (Object.keys(set).length > 0) document.$set = set;
  // `$inc`, not a read-modify-write: two workers on the same drive must not each read the old
  // count and write their own.
  if (update.incrementFailures) document.$inc = { consecutiveFailures: update.incrementFailures };
  if (Object.keys(document).length === 0) return;

  await DriveSyncStateModel.updateOne({ _id: oid(id) }, document).exec();
}

export async function advanceCursor(input: AdvanceCursorInput): Promise<boolean> {
  await connectToDatabase();

  const result = await DriveSyncStateModel.updateOne(
    { _id: oid(input.id), startPageToken: input.from },
    {
      $set: { startPageToken: input.to, tokenExpiredAt: null },
      $inc: { changesApplied: input.appliedDelta, conflictsDetected: input.conflictsDelta },
    },
  ).exec();

  return result.modifiedCount > 0;
}

export const mongoDriveSyncRepository: DriveSyncRepository = {
  ensureState,
  findState,
  listStates,
  updateState,
  advanceCursor,
};
