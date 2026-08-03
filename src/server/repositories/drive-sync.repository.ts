/**
 * The cursor into Drive's change feed, and the record of how synchronization is going.
 *
 * One document per Shared Drive, created on first use. Everything here is about a single
 * field — `startPageToken` — and the discipline around it:
 *
 *   • It is advanced **after** a page's changes have been applied, never before. A crash
 *     mid-page replays that page, and every change application is idempotent, so replaying
 *     costs a little work and changes nothing. Advancing first would silently skip changes,
 *     and nothing would ever notice.
 *
 *   • `tokenExpiredAt` is not decoration. Drive expires cursors, and a 404 on one is *not*
 *     "no changes" — it means the feed moved past what we last saw and an unknown set of
 *     renames, moves and deletions happened while nobody was looking. Recording it is what
 *     forces a full reconcile instead of a cheerful empty poll.
 */
import { Types, type ClientSession } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { DriveSyncStateModel, type DriveSyncRunState } from '@/server/db/models/drive-sync-state.model';

export interface DriveSyncStateRecord {
  id: string;
  organizationId: string;
  sharedDriveId: string;
  state: DriveSyncRunState;
  startPageToken: string | null;
  tokenExpiredAt: Date | null;
  lastPollAt: Date | null;
  lastSuccessfulPollAt: Date | null;
  lastFullReconcileAt: Date | null;
  changesApplied: number;
  conflictsDetected: number;
  consecutiveFailures: number;
  lastError: string | null;
  updatedAt: Date;
}

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

export async function updateState(
  id: string,
  update: Record<string, unknown>,
  session?: ClientSession,
): Promise<void> {
  await connectToDatabase();
  const query = DriveSyncStateModel.updateOne({ _id: oid(id) }, update);
  if (session) query.session(session);
  await query.exec();
}

/**
 * Advances the cursor, and only the cursor.
 *
 * Filtered on the token we believe is current, so a second worker that polled the same page
 * concurrently cannot wind the cursor backwards. Returns false when that happened, which the
 * caller treats as "somebody else is ahead of us" rather than as an error.
 */
export async function advanceCursor(input: {
  id: string;
  from: string | null;
  to: string;
  appliedDelta: number;
  conflictsDelta: number;
}): Promise<boolean> {
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
