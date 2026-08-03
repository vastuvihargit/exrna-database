import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import {
  MigrationItemModel,
  MigrationJobModel,
  type MigrationItemDocument,
  type MigrationItemStatus,
  type MigrationJobDocument,
  type MigrationStatus,
} from '@/server/db/models';
import type { ConfidentialityLevel } from '@/server/domain/permissions';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

function isValidId(value: string): boolean {
  return Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value);
}

/* ------------------------------------------------------------------- jobs */

export interface MigrationCounters {
  scannedFiles: number;
  scannedFolders: number;
  scannedBytes: number;
  imported: number;
  importedBytes: number;
  skippedDuplicates: number;
  skippedUnsupported: number;
  failed: number;
}

export interface MigrationJobRecord {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  status: MigrationStatus;
  targetFolderId: string;
  departmentId: string | null;
  projectId: string | null;
  confidentiality: ConfidentialityLevel;
  sourceFolderIds: string[];
  connection: {
    accountEmail: string | null;
    connected: boolean;
    scope: string | null;
    connectedAt: Date | null;
  };
  options: {
    preserveHierarchy: boolean;
    preserveDates: boolean;
    skipDuplicates: boolean;
    exportGoogleDocs: boolean;
  };
  counters: MigrationCounters;
  scanStartedAt: Date | null;
  scanCompletedAt: Date | null;
  importStartedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

type LeanJob = MigrationJobDocument & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

/**
 * Note what is *not* here: `refreshTokenCipher`.
 *
 * The record type has no field for it, so no route, DTO or log statement can reach it
 * through a job record however carelessly it is spread. The one code path that needs the
 * credential asks for it explicitly, below.
 */
function toJobRecord(doc: LeanJob): MigrationJobRecord {
  const connection = (doc.connection ?? {}) as Record<string, unknown>;
  const options = (doc.options ?? {}) as Record<string, unknown>;
  const counters = (doc.counters ?? {}) as Record<string, number>;

  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    name: doc.name,
    description: doc.description ?? '',
    status: doc.status as MigrationStatus,
    targetFolderId: String(doc.targetFolderId),
    departmentId: doc.departmentId ? String(doc.departmentId) : null,
    projectId: doc.projectId ? String(doc.projectId) : null,
    confidentiality: doc.confidentiality as ConfidentialityLevel,
    sourceFolderIds: doc.sourceFolderIds ?? [],
    connection: {
      accountEmail: (connection.accountEmail as string | null) ?? null,
      connected: Boolean(connection.refreshTokenCipher),
      scope: (connection.scope as string | null) ?? null,
      connectedAt: (connection.connectedAt as Date | null) ?? null,
    },
    options: {
      preserveHierarchy: options.preserveHierarchy !== false,
      preserveDates: options.preserveDates !== false,
      skipDuplicates: options.skipDuplicates !== false,
      exportGoogleDocs: options.exportGoogleDocs !== false,
    },
    counters: {
      scannedFiles: counters.scannedFiles ?? 0,
      scannedFolders: counters.scannedFolders ?? 0,
      scannedBytes: counters.scannedBytes ?? 0,
      imported: counters.imported ?? 0,
      importedBytes: counters.importedBytes ?? 0,
      skippedDuplicates: counters.skippedDuplicates ?? 0,
      skippedUnsupported: counters.skippedUnsupported ?? 0,
      failed: counters.failed ?? 0,
    },
    scanStartedAt: doc.scanStartedAt ?? null,
    scanCompletedAt: doc.scanCompletedAt ?? null,
    importStartedAt: doc.importStartedAt ?? null,
    completedAt: doc.completedAt ?? null,
    lastError: doc.lastError ?? null,
    createdBy: String(doc.createdBy),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function findJob(id: string): Promise<MigrationJobRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const doc = await MigrationJobModel.findOne({ _id: oid(id) }).lean<LeanJob>().exec();
  return doc ? toJobRecord(doc) : null;
}

export async function listJobs(
  organizationId: string,
  limit = 100,
): Promise<MigrationJobRecord[]> {
  await connectToDatabase();
  const docs = await MigrationJobModel.find({ organizationId: oid(organizationId) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<LeanJob[]>()
    .exec();
  return docs.map(toJobRecord);
}

/**
 * Reads the stored credential.
 *
 * A named, single-purpose function so that "who can obtain the Drive refresh token?" is a
 * question with a greppable answer — one call site, in the migration service.
 */
export async function getRefreshTokenCipher(jobId: string): Promise<string | null> {
  if (!isValidId(jobId)) return null;
  await connectToDatabase();
  const doc = await MigrationJobModel.findOne({ _id: oid(jobId) })
    .select({ 'connection.refreshTokenCipher': 1 })
    .lean<{ connection?: { refreshTokenCipher?: string | null } }>()
    .exec();
  return doc?.connection?.refreshTokenCipher ?? null;
}

export interface CreateJobInput {
  organizationId: string;
  name: string;
  description?: string;
  targetFolderId: string;
  departmentId: string | null;
  projectId: string | null;
  confidentiality: ConfidentialityLevel;
  sourceFolderIds?: string[];
  options?: Partial<MigrationJobRecord['options']>;
  createdBy: string;
}

export async function createJob(input: CreateJobInput): Promise<MigrationJobRecord> {
  await connectToDatabase();
  const [doc] = await MigrationJobModel.create([
    {
      organizationId: oid(input.organizationId),
      name: input.name,
      description: input.description ?? '',
      targetFolderId: oid(input.targetFolderId),
      departmentId: input.departmentId ? oid(input.departmentId) : null,
      projectId: input.projectId ? oid(input.projectId) : null,
      confidentiality: input.confidentiality,
      sourceFolderIds: input.sourceFolderIds ?? [],
      options: input.options ?? {},
      createdBy: oid(input.createdBy),
    },
  ]);
  return toJobRecord(doc!.toObject() as LeanJob);
}

export async function updateJob(
  id: string,
  update: Record<string, unknown>,
  session?: ClientSession,
): Promise<MigrationJobRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const query = MigrationJobModel.findOneAndUpdate({ _id: oid(id) }, update, { new: true });
  if (session) query.session(session);
  const doc = await query.lean<LeanJob>().exec();
  return doc ? toJobRecord(doc) : null;
}

/**
 * Moves a job into a running state only if it is in one of the states that may start.
 *
 * An atomic claim, exactly like the upload session's: two administrators pressing "run"
 * at the same moment must not both start importing the same items.
 */
export async function claimJobForRun(
  id: string,
  from: MigrationStatus[],
  to: MigrationStatus,
  set: Record<string, unknown> = {},
): Promise<MigrationJobRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const doc = await MigrationJobModel.findOneAndUpdate(
    { _id: oid(id), status: { $in: from } },
    { $set: { status: to, lastError: null, ...set } },
    { new: true },
  )
    .lean<LeanJob>()
    .exec();
  return doc ? toJobRecord(doc) : null;
}

export async function incrementCounters(
  id: string,
  deltas: Partial<MigrationCounters>,
): Promise<void> {
  const inc: Record<string, number> = {};
  for (const [key, value] of Object.entries(deltas)) {
    if (value) inc[`counters.${key}`] = value;
  }
  if (Object.keys(inc).length === 0) return;
  await connectToDatabase();
  await MigrationJobModel.updateOne({ _id: oid(id) }, { $inc: inc }).exec();
}

export async function softDeleteJob(id: string, deletedBy: string): Promise<boolean> {
  if (!isValidId(id)) return false;
  await connectToDatabase();
  const result = await MigrationJobModel.updateOne(
    { _id: oid(id) },
    // The credential goes with the job. A disconnected job that still holds a token to
    // the company's Drive is a dormant liability with no purpose.
    {
      $set: {
        deletedAt: new Date(),
        deletedBy: oid(deletedBy),
        'connection.refreshTokenCipher': null,
      },
    },
  ).exec();
  return result.modifiedCount > 0;
}

/* ------------------------------------------------------------------ items */

export interface MigrationItemRecord {
  id: string;
  jobId: string;
  driveFileId: string;
  driveParentId: string | null;
  sourcePath: string;
  name: string;
  mimeType: string;
  declaredSize: number;
  driveMd5: string | null;
  driveCreatedTime: Date | null;
  driveModifiedTime: Date | null;
  isGoogleNative: boolean;
  status: MigrationItemStatus;
  targetFolderId: string | null;
  resultFileId: string | null;
  resultVersionId: string | null;
  checksumSha256: string | null;
  importedBytes: number;
  duplicateOfFileId: string | null;
  attempts: number;
  lastError: string | null;
  importedAt: Date | null;
  createdAt: Date;
}

type LeanItem = MigrationItemDocument & { _id: Types.ObjectId; createdAt: Date };

function toItemRecord(doc: LeanItem): MigrationItemRecord {
  return {
    id: String(doc._id),
    jobId: String(doc.jobId),
    driveFileId: doc.driveFileId,
    driveParentId: doc.driveParentId ?? null,
    sourcePath: doc.sourcePath ?? '',
    name: doc.name,
    mimeType: doc.mimeType ?? '',
    declaredSize: doc.declaredSize ?? 0,
    driveMd5: doc.driveMd5 ?? null,
    driveCreatedTime: doc.driveCreatedTime ?? null,
    driveModifiedTime: doc.driveModifiedTime ?? null,
    isGoogleNative: Boolean(doc.isGoogleNative),
    status: doc.status as MigrationItemStatus,
    targetFolderId: doc.targetFolderId ? String(doc.targetFolderId) : null,
    resultFileId: doc.resultFileId ? String(doc.resultFileId) : null,
    resultVersionId: doc.resultVersionId ? String(doc.resultVersionId) : null,
    checksumSha256: doc.checksumSha256 ?? null,
    importedBytes: doc.importedBytes ?? 0,
    duplicateOfFileId: doc.duplicateOfFileId ? String(doc.duplicateOfFileId) : null,
    attempts: doc.attempts ?? 0,
    lastError: doc.lastError ?? null,
    importedAt: doc.importedAt ?? null,
    createdAt: doc.createdAt,
  };
}

export interface UpsertItemInput {
  organizationId: string;
  jobId: string;
  driveFileId: string;
  driveParentId: string | null;
  sourcePath: string;
  name: string;
  mimeType: string;
  declaredSize: number;
  driveMd5: string | null;
  driveCreatedTime: Date | null;
  driveModifiedTime: Date | null;
  isGoogleNative: boolean;
}

/**
 * Records a scanned file, or refreshes what is known about one.
 *
 * `$setOnInsert` on `status` is what makes re-scanning safe: a file already imported
 * stays `imported`, so a second scan cannot resurrect it as pending and import it twice.
 */
export async function upsertItem(input: UpsertItemInput): Promise<{ created: boolean }> {
  await connectToDatabase();
  const result = await MigrationItemModel.updateOne(
    { jobId: oid(input.jobId), driveFileId: input.driveFileId },
    {
      $set: {
        driveParentId: input.driveParentId,
        sourcePath: input.sourcePath,
        name: input.name,
        mimeType: input.mimeType,
        declaredSize: input.declaredSize,
        driveMd5: input.driveMd5,
        driveCreatedTime: input.driveCreatedTime,
        driveModifiedTime: input.driveModifiedTime,
        isGoogleNative: input.isGoogleNative,
      },
      $setOnInsert: {
        organizationId: oid(input.organizationId),
        jobId: oid(input.jobId),
        driveFileId: input.driveFileId,
        status: 'pending',
      },
    },
    { upsert: true },
  ).exec();

  return { created: result.upsertedCount > 0 };
}

/**
 * Atomically claims the next item to import.
 *
 * The status transition is the lock. Two workers on the same job take different items
 * rather than racing on one, and a crash leaves the item in `importing` where the retry
 * path can find it.
 */
export async function claimNextPendingItem(
  jobId: string,
  statuses: MigrationItemStatus[] = ['pending'],
): Promise<MigrationItemRecord | null> {
  if (!isValidId(jobId)) return null;
  await connectToDatabase();
  const doc = await MigrationItemModel.findOneAndUpdate(
    { jobId: oid(jobId), status: { $in: statuses } },
    { $set: { status: 'importing' }, $inc: { attempts: 1 } },
    { new: true, sort: { _id: 1 } },
  )
    .lean<LeanItem>()
    .exec();
  return doc ? toItemRecord(doc) : null;
}

/**
 * Points a *not yet imported* item at the folder it should land in.
 *
 * The `status: 'pending'` filter is the whole point: a re-scan after someone moved a file
 * in Drive must not retarget an item that has already been imported, which would leave
 * the report claiming the file is somewhere it is not.
 */
export async function updateItemTargetIfPending(
  jobId: string,
  driveFileId: string,
  targetFolderId: string,
): Promise<void> {
  if (!isValidId(jobId) || !isValidId(targetFolderId)) return;
  await connectToDatabase();
  await MigrationItemModel.updateOne(
    { jobId: oid(jobId), driveFileId, status: 'pending' },
    { $set: { targetFolderId: oid(targetFolderId) } },
  ).exec();
}

export async function updateItem(
  id: string,
  update: Record<string, unknown>,
  session?: ClientSession,
): Promise<MigrationItemRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const query = MigrationItemModel.findOneAndUpdate({ _id: oid(id) }, update, { new: true });
  if (session) query.session(session);
  const doc = await query.lean<LeanItem>().exec();
  return doc ? toItemRecord(doc) : null;
}

export async function listItems(input: {
  jobId: string;
  status?: MigrationItemStatus;
  page: number;
  pageSize: number;
}): Promise<{ items: MigrationItemRecord[]; total: number }> {
  if (!isValidId(input.jobId)) return { items: [], total: 0 };
  await connectToDatabase();

  const filter: FilterQuery<MigrationItemDocument> = { jobId: oid(input.jobId) };
  if (input.status) filter.status = input.status;

  const [docs, total] = await Promise.all([
    MigrationItemModel.find(filter)
      .sort({ _id: 1 })
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean<LeanItem[]>()
      .exec(),
    MigrationItemModel.countDocuments(filter).exec(),
  ]);

  return { items: docs.map(toItemRecord), total };
}

export async function countItemsByStatus(jobId: string): Promise<Record<string, number>> {
  if (!isValidId(jobId)) return {};
  await connectToDatabase();
  const rows = await MigrationItemModel.aggregate<{ _id: string; count: number }>([
    { $match: { jobId: oid(jobId) } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).exec();

  const out: Record<string, number> = {};
  for (const row of rows) out[row._id] = row.count;
  return out;
}

/** Returns failed items to `pending` so a run picks them up again. */
export async function resetFailedItems(jobId: string): Promise<number> {
  if (!isValidId(jobId)) return 0;
  await connectToDatabase();
  const result = await MigrationItemModel.updateMany(
    // `importing` is included: an item left mid-flight by a crashed run is stuck
    // otherwise, and its bytes were discarded with the staging file.
    { jobId: oid(jobId), status: { $in: ['failed', 'importing'] } },
    { $set: { status: 'pending', lastError: null } },
  ).exec();
  return result.modifiedCount;
}

/** Has this Drive file already been imported by any job in the organization? */
export async function findImportedByDriveFileId(
  organizationId: string,
  driveFileId: string,
): Promise<MigrationItemRecord | null> {
  await connectToDatabase();
  const doc = await MigrationItemModel.findOne({
    organizationId: oid(organizationId),
    driveFileId,
    status: 'imported',
    resultFileId: { $ne: null },
  })
    .lean<LeanItem>()
    .exec();
  return doc ? toItemRecord(doc) : null;
}
