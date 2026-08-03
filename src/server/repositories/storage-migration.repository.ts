/**
 * Persistence for the outbound storage migration.
 *
 * ⚠ Not `migration.repository` — that belongs to the *inbound* Drive importer. See the
 * header of `storage-migration-job.model.ts`.
 *
 * The function that matters here is `claimNextItem`. Everything else is bookkeeping; that
 * one is the concurrency control for a process that moves the company's research data, and
 * it is deliberately a single atomic `findOneAndUpdate` rather than a read followed by a
 * write. Two workers — or one worker restarted after a crash while another is still
 * running — must never both be transferring the same version.
 */
import { Types, type FilterQuery } from 'mongoose';

import { connectToDatabase } from '@/server/db/connection';
import { StorageMigrationJobModel, type StorageMigrationJobDocument } from '@/server/db/models/storage-migration-job.model';
import {
  StorageMigrationItemModel,
  type StorageMigrationItemDocument,
  type StorageMigrationFailureCode,
} from '@/server/db/models/storage-migration-item.model';
import { StorageRecoveryItemModel } from '@/server/db/models/storage-recovery-item.model';
import type { StorageMigrationStatus } from '@/server/db/storage-fields';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export function isValidId(value: string): boolean {
  return Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value);
}

export function newId(): string {
  return new Types.ObjectId().toHexString();
}

/* ------------------------------------------------------------------------ jobs */

export interface JobRecord {
  id: string;
  organizationId: string;
  name: string;
  mode: string;
  status: string;
  selection: StorageMigrationJobDocument['selection'];
  counters: StorageMigrationJobDocument['counters'];
  pauseRequested: boolean;
  cancelRequested: boolean;
  failureCounts: Record<string, number>;
  plannedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastError: string | null;
  lastProgressAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

function toJobRecord(doc: StorageMigrationJobDocument & { _id: Types.ObjectId; createdAt: Date }): JobRecord {
  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    name: doc.name,
    mode: doc.mode,
    status: doc.status,
    selection: doc.selection,
    counters: doc.counters,
    pauseRequested: doc.pauseRequested,
    cancelRequested: doc.cancelRequested,
    failureCounts: (doc.failureCounts as Record<string, number>) ?? {},
    plannedAt: doc.plannedAt ?? null,
    startedAt: doc.startedAt ?? null,
    finishedAt: doc.finishedAt ?? null,
    lastError: doc.lastError ?? null,
    lastProgressAt: doc.lastProgressAt ?? null,
    createdBy: String(doc.createdBy),
    createdAt: doc.createdAt,
  };
}

export async function createJob(input: {
  organizationId: string;
  name: string;
  description?: string;
  mode: string;
  selection: Record<string, unknown>;
  createdBy: string;
}): Promise<JobRecord> {
  await connectToDatabase();
  const doc = await StorageMigrationJobModel.create({
    organizationId: oid(input.organizationId),
    name: input.name,
    description: input.description ?? '',
    mode: input.mode,
    selection: input.selection,
    createdBy: oid(input.createdBy),
  });
  return toJobRecord(doc.toObject() as never);
}

export async function findJob(id: string): Promise<JobRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const doc = await StorageMigrationJobModel.findById(oid(id)).lean().exec();
  return doc ? toJobRecord(doc as never) : null;
}

export async function listJobs(organizationId: string, limit = 50): Promise<JobRecord[]> {
  await connectToDatabase();
  const docs = await StorageMigrationJobModel.find({ organizationId: oid(organizationId) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
    .exec();
  return docs.map((doc) => toJobRecord(doc as never));
}

export async function updateJob(id: string, update: Record<string, unknown>): Promise<void> {
  if (!isValidId(id)) return;
  await connectToDatabase();
  await StorageMigrationJobModel.updateOne({ _id: oid(id) }, update).exec();
}

/**
 * Counters move with `$inc`, never by writing a computed total.
 *
 * A worker that read "uploaded: 40", transferred one, and wrote back 41 would lose every
 * increment another worker made in between. `$inc` is applied by the database and composes.
 */
export async function incrementCounters(
  jobId: string,
  counters: Partial<Record<keyof StorageMigrationJobDocument['counters'], number>>,
  failureCode?: string | null,
): Promise<void> {
  if (!isValidId(jobId)) return;
  await connectToDatabase();

  const inc: Record<string, number> = {};
  for (const [key, value] of Object.entries(counters)) {
    if (typeof value === 'number' && value !== 0) inc[`counters.${key}`] = value;
  }
  if (failureCode) inc[`failureCounts.${failureCode}`] = 1;

  if (Object.keys(inc).length === 0) return;
  await StorageMigrationJobModel.updateOne(
    { _id: oid(jobId) },
    { $inc: inc, $set: { lastProgressAt: new Date() } },
  ).exec();
}

/* ----------------------------------------------------------------------- items */

export interface ItemRecord {
  id: string;
  jobId: string;
  organizationId: string;
  versionId: string;
  fileId: string;
  folderId: string;
  displayName: string;
  versionNumber: number;
  sizeBytes: number;
  status: StorageMigrationStatus;
  idempotencyKey: string;
  googleDriveFileId: string | null;
  localSha256: string | null;
  localMd5: string | null;
  remoteMd5: string | null;
  checksumVerified: boolean;
  attempts: number;
  failureCode: StorageMigrationFailureCode | null;
  failureDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  transferMs: number | null;
}

function toItemRecord(doc: StorageMigrationItemDocument & { _id: Types.ObjectId }): ItemRecord {
  return {
    id: String(doc._id),
    jobId: String(doc.jobId),
    organizationId: String(doc.organizationId),
    versionId: String(doc.versionId),
    fileId: String(doc.fileId),
    folderId: String(doc.folderId),
    displayName: doc.displayName,
    versionNumber: doc.versionNumber,
    sizeBytes: doc.sizeBytes,
    status: doc.status as StorageMigrationStatus,
    idempotencyKey: doc.idempotencyKey,
    googleDriveFileId: doc.googleDriveFileId ?? null,
    localSha256: doc.localSha256 ?? null,
    localMd5: doc.localMd5 ?? null,
    remoteMd5: doc.remoteMd5 ?? null,
    checksumVerified: doc.checksumVerified,
    attempts: doc.attempts,
    failureCode: (doc.failureCode as StorageMigrationFailureCode | null) ?? null,
    failureDetail: doc.failureDetail ?? null,
    startedAt: doc.startedAt ?? null,
    finishedAt: doc.finishedAt ?? null,
    transferMs: doc.transferMs ?? null,
  };
}

export interface NewItem {
  jobId: string;
  organizationId: string;
  versionId: string;
  fileId: string;
  folderId: string;
  displayName: string;
  versionNumber: number;
  sizeBytes: number;
  status: StorageMigrationStatus;
}

/**
 * Inserts a planned batch.
 *
 * Unordered and duplicate-tolerant: re-planning a job must be idempotent, and the unique
 * index on `(jobId, versionId)` is what enforces that. A re-plan after new versions were
 * uploaded therefore adds only the new ones instead of failing on the first collision.
 */
export async function insertItems(items: NewItem[]): Promise<number> {
  if (items.length === 0) return 0;
  await connectToDatabase();

  const docs = items.map((item) => ({
    jobId: oid(item.jobId),
    organizationId: oid(item.organizationId),
    versionId: oid(item.versionId),
    fileId: oid(item.fileId),
    folderId: oid(item.folderId),
    displayName: item.displayName,
    versionNumber: item.versionNumber,
    sizeBytes: item.sizeBytes,
    status: item.status,
    // Stable across retries and re-plans: it identifies the *work*, not the attempt. This
    // is what a recovery sweep searches Drive for after a crash.
    idempotencyKey: `${item.jobId}:${item.versionId}`,
  }));

  try {
    const inserted = await StorageMigrationItemModel.insertMany(docs, { ordered: false });
    return inserted.length;
  } catch (error) {
    // A bulk write that hit duplicates still inserted the rest. `insertedDocs` is what
    // actually landed; the duplicates are the point of the index, not a failure.
    const result = error as { insertedDocs?: unknown[]; code?: number; writeErrors?: unknown[] };
    if (Array.isArray(result.insertedDocs)) return result.insertedDocs.length;
    throw error;
  }
}

/**
 * Takes exclusive ownership of the next transferable item, atomically.
 *
 * The filter is the lock: only a row still in a claimable state matches, and the same
 * update that changes the status sets `claimActive`, which the unique partial index on
 * `versionId` then enforces globally. A second worker gets `null` and moves on.
 *
 * Ordered by `_id` so the queue is stable and a resumed job continues where it stopped
 * rather than re-walking from the beginning.
 */
export async function claimNextItem(input: {
  jobId: string;
  workerId: string;
  retryFailed?: boolean;
}): Promise<ItemRecord | null> {
  await connectToDatabase();

  const claimable: StorageMigrationStatus[] = input.retryFailed
    ? ['not_started', 'queued', 'failed']
    : ['not_started', 'queued'];

  const doc = await StorageMigrationItemModel.findOneAndUpdate(
    { jobId: oid(input.jobId), status: { $in: claimable }, claimActive: { $ne: true } },
    {
      $set: {
        status: 'uploading',
        claimActive: true,
        claimedAt: new Date(),
        claimedBy: input.workerId,
        startedAt: new Date(),
      },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { _id: 1 } },
  )
    .lean()
    .exec();

  return doc ? toItemRecord(doc as never) : null;
}

/** Releases a claim without judging the outcome — used when a run is paused mid-queue. */
export async function releaseClaim(itemId: string, status: StorageMigrationStatus): Promise<void> {
  await connectToDatabase();
  await StorageMigrationItemModel.updateOne(
    { _id: oid(itemId) },
    { $set: { status, claimActive: false, claimedAt: null, claimedBy: null } },
  ).exec();
}

export async function updateItem(itemId: string, update: Record<string, unknown>): Promise<void> {
  await connectToDatabase();
  await StorageMigrationItemModel.updateOne({ _id: oid(itemId) }, { $set: update }).exec();
}

export async function completeItem(input: {
  itemId: string;
  googleDriveFileId: string;
  localSha256: string;
  localMd5: string;
  remoteMd5: string;
  transferMs: number;
}): Promise<void> {
  await connectToDatabase();
  await StorageMigrationItemModel.updateOne(
    { _id: oid(input.itemId) },
    {
      $set: {
        status: 'verified',
        claimActive: false,
        claimedAt: null,
        claimedBy: null,
        googleDriveFileId: input.googleDriveFileId,
        localSha256: input.localSha256,
        localMd5: input.localMd5,
        remoteMd5: input.remoteMd5,
        checksumVerified: true,
        finishedAt: new Date(),
        transferMs: input.transferMs,
        failureCode: null,
        failureDetail: null,
      },
    },
  ).exec();
}

export async function failItem(input: {
  itemId: string;
  code: StorageMigrationFailureCode;
  detail: string;
}): Promise<void> {
  await connectToDatabase();
  await StorageMigrationItemModel.updateOne(
    { _id: oid(input.itemId) },
    {
      $set: {
        status: 'failed',
        claimActive: false,
        claimedAt: null,
        claimedBy: null,
        failureCode: input.code,
        failureDetail: input.detail.slice(0, 1000),
        finishedAt: new Date(),
      },
    },
  ).exec();
}

export async function countItemsByStatus(jobId: string): Promise<Record<string, number>> {
  await connectToDatabase();
  const rows = await StorageMigrationItemModel.aggregate<{ _id: string; count: number }>([
    { $match: { jobId: oid(jobId) } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).exec();

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row._id] = row.count;
  return counts;
}

export async function listItems(input: {
  jobId: string;
  status?: string;
  failedOnly?: boolean;
  limit: number;
  afterId?: string;
}): Promise<ItemRecord[]> {
  await connectToDatabase();

  const filter: FilterQuery<StorageMigrationItemDocument> = { jobId: oid(input.jobId) };
  if (input.status) filter.status = input.status;
  if (input.failedOnly) filter.status = 'failed';
  if (input.afterId && isValidId(input.afterId)) filter._id = { $gt: oid(input.afterId) };

  const docs = await StorageMigrationItemModel.find(filter)
    .sort({ _id: 1 })
    .limit(input.limit)
    .lean()
    .exec();
  return docs.map((doc) => toItemRecord(doc as never));
}

export async function listVerifiedItems(jobId: string, limit: number, afterId?: string): Promise<ItemRecord[]> {
  return listItems({ jobId, status: 'verified', limit, ...(afterId ? { afterId } : {}) });
}

/** Reopens failed items so a retry run can claim them. Returns how many were reset. */
export async function requeueFailed(jobId: string): Promise<number> {
  await connectToDatabase();
  const result = await StorageMigrationItemModel.updateMany(
    { jobId: oid(jobId), status: 'failed' },
    { $set: { status: 'queued', failureCode: null, failureDetail: null, claimActive: false } },
  ).exec();
  return result.modifiedCount;
}

/**
 * Releases claims abandoned by a worker that died mid-transfer.
 *
 * Without this a crash leaves rows permanently `claimActive`, and the unique index then
 * blocks every future attempt on those versions — the safety mechanism becoming a
 * deadlock. The staleness window has to exceed the longest plausible single transfer.
 */
export async function releaseStaleClaims(jobId: string, olderThan: Date): Promise<number> {
  await connectToDatabase();
  const result = await StorageMigrationItemModel.updateMany(
    { jobId: oid(jobId), claimActive: true, claimedAt: { $lt: olderThan } },
    { $set: { status: 'queued', claimActive: false, claimedAt: null, claimedBy: null } },
  ).exec();
  return result.modifiedCount;
}

/* -------------------------------------------------------------------- recovery */

/**
 * Opens a recovery row *before* a Drive write, and is idempotent on the key.
 *
 * A retry re-entering the same code path must find the existing row rather than opening a
 * second one — which the unique partial index on `idempotencyKey` enforces, so the upsert
 * here is belt and braces rather than the actual guarantee.
 */
export async function openRecovery(input: {
  organizationId: string;
  versionId: string;
  /** Null for a transfer that came from an upload rather than a migration job. */
  jobId?: string | null;
  idempotencyKey: string;
  phase: string;
}): Promise<void> {
  await connectToDatabase();
  await StorageRecoveryItemModel.updateOne(
    { idempotencyKey: input.idempotencyKey, status: 'open' },
    {
      $setOnInsert: {
        organizationId: oid(input.organizationId),
        versionId: oid(input.versionId),
        jobId: input.jobId ? oid(input.jobId) : null,
        idempotencyKey: input.idempotencyKey,
        phase: input.phase,
        status: 'open',
      },
      $set: { lastAttemptAt: new Date() },
      $inc: { attempts: 1 },
    },
    { upsert: true },
  ).exec();
}

export async function advanceRecovery(idempotencyKey: string, update: Record<string, unknown>): Promise<void> {
  await connectToDatabase();
  await StorageRecoveryItemModel.updateOne(
    { idempotencyKey, status: 'open' },
    { $set: update },
  ).exec();
}

export async function closeRecovery(idempotencyKey: string, status: string): Promise<void> {
  await connectToDatabase();
  await StorageRecoveryItemModel.updateOne(
    { idempotencyKey, status: 'open' },
    { $set: { status, resolvedAt: new Date() } },
  ).exec();
}

export async function findOpenRecovery(idempotencyKey: string): Promise<{
  observedDriveFileId: string | null;
  phase: string;
} | null> {
  await connectToDatabase();
  const doc = await StorageRecoveryItemModel.findOne({ idempotencyKey, status: 'open' })
    .lean<{ observedDriveFileId?: string | null; phase: string }>()
    .exec();
  return doc ? { observedDriveFileId: doc.observedDriveFileId ?? null, phase: doc.phase } : null;
}

export async function countOpenRecoveries(organizationId: string): Promise<number> {
  await connectToDatabase();
  return StorageRecoveryItemModel.countDocuments({
    organizationId: oid(organizationId),
    status: 'open',
  }).exec();
}
