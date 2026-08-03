import { Types, type ClientSession } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { UploadSessionModel, type UploadSessionDocument, type UploadStatus } from '@/server/db/models';

export interface UploadSessionRecord {
  id: string;
  organizationId: string;
  userId: string;
  folderId: string;
  targetFileId: string | null;
  declaredFilename: string;
  displayName: string;
  extension: string;
  declaredSize: number;
  declaredMimeType: string | null;
  resolvedMimeType: string;
  versionNote: string;
  status: UploadStatus;
  receivedBytes: number;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number[];
  quarantineKey: string | null;
  checksumSha256: string | null;
  resultFileId: string | null;
  resultVersionId: string | null;
  failureReason: string | null;
  finalizationKey: string | null;
  expiresAt: Date;
  createdAt: Date;
}

type LeanSession = UploadSessionDocument & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

function isValidId(value: string): boolean {
  return Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value);
}

function toRecord(doc: LeanSession): UploadSessionRecord {
  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    userId: String(doc.userId),
    folderId: String(doc.folderId),
    targetFileId: doc.targetFileId ? String(doc.targetFileId) : null,
    declaredFilename: doc.declaredFilename,
    displayName: doc.displayName,
    extension: doc.extension,
    declaredSize: doc.declaredSize,
    declaredMimeType: doc.declaredMimeType ?? null,
    resolvedMimeType: doc.resolvedMimeType,
    versionNote: doc.versionNote ?? '',
    status: doc.status as UploadStatus,
    receivedBytes: doc.receivedBytes ?? 0,
    chunkSize: doc.chunkSize ?? 0,
    totalChunks: doc.totalChunks ?? 0,
    receivedChunks: doc.receivedChunks ?? [],
    quarantineKey: doc.quarantineKey ?? null,
    checksumSha256: doc.checksumSha256 ?? null,
    resultFileId: doc.resultFileId ? String(doc.resultFileId) : null,
    resultVersionId: doc.resultVersionId ? String(doc.resultVersionId) : null,
    failureReason: doc.failureReason ?? null,
    finalizationKey: doc.finalizationKey ?? null,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
  };
}

export async function findById(id: string): Promise<UploadSessionRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const doc = await UploadSessionModel.findOne({ _id: oid(id) }).lean<LeanSession>().exec();
  return doc ? toRecord(doc) : null;
}

export interface CreateUploadSessionInput {
  organizationId: string;
  userId: string;
  folderId: string;
  targetFileId?: string | null;
  declaredFilename: string;
  displayName: string;
  extension: string;
  declaredSize: number;
  declaredMimeType?: string | null;
  resolvedMimeType: string;
  versionNote?: string;
  chunkSize?: number;
  totalChunks?: number;
  expiresAt: Date;
}

export async function create(input: CreateUploadSessionInput): Promise<UploadSessionRecord> {
  await connectToDatabase();
  const doc = await UploadSessionModel.create({
    organizationId: oid(input.organizationId),
    userId: oid(input.userId),
    folderId: oid(input.folderId),
    targetFileId: input.targetFileId ? oid(input.targetFileId) : null,
    declaredFilename: input.declaredFilename,
    displayName: input.displayName,
    extension: input.extension,
    declaredSize: input.declaredSize,
    declaredMimeType: input.declaredMimeType ?? null,
    resolvedMimeType: input.resolvedMimeType,
    versionNote: input.versionNote ?? '',
    chunkSize: input.chunkSize ?? 0,
    totalChunks: input.totalChunks ?? 0,
    expiresAt: input.expiresAt,
  });
  return toRecord(doc.toObject() as LeanSession);
}

export async function update(
  id: string,
  changes: Record<string, unknown>,
  session?: ClientSession,
): Promise<UploadSessionRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const query = UploadSessionModel.findOneAndUpdate({ _id: oid(id) }, changes, { new: true });
  if (session) query.session(session);
  const doc = await query.lean<LeanSession>().exec();
  return doc ? toRecord(doc) : null;
}

/**
 * Marks a session failed unless it already reached a terminal state.
 *
 * `rejected` and `ready` are decisions, not accidents: a file refused for its content is
 * a different thing from an upload that broke, and the admin review of quarantined files
 * needs to tell them apart. Filtered rather than read-then-write so a concurrent
 * rejection cannot be overwritten in the gap.
 */
export async function markFailed(id: string, reason: string): Promise<void> {
  if (!isValidId(id)) return;
  await connectToDatabase();
  await UploadSessionModel.updateOne(
    { _id: oid(id), status: { $nin: ['ready', 'rejected', 'aborted'] } },
    { $set: { status: 'failed', failureReason: reason.slice(0, 500) } },
  ).exec();
}

/**
 * Claims a session for finalization, atomically.
 *
 * The status transition is the lock: only the request that moves a session out of
 * `uploading` gets to build the file. A concurrent retry finds nothing to claim and
 * reads the already-stored result instead — which is what makes finalization idempotent
 * under a client that retries on timeout.
 */
export async function claimForFinalization(
  id: string,
  finalizationKey: string,
): Promise<UploadSessionRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const doc = await UploadSessionModel.findOneAndUpdate(
    { _id: oid(id), status: { $in: ['uploading', 'pending'] }, finalizationKey: null },
    { $set: { status: 'processing', finalizationKey } },
    { new: true },
  )
    .lean<LeanSession>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function recordChunk(
  id: string,
  chunkIndex: number,
  bytes: number,
): Promise<UploadSessionRecord | null> {
  await connectToDatabase();
  const doc = await UploadSessionModel.findOneAndUpdate(
    { _id: oid(id) },
    {
      $addToSet: { receivedChunks: chunkIndex },
      $inc: { receivedBytes: bytes },
      $set: { status: 'uploading' },
    },
    { new: true },
  )
    .lean<LeanSession>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function listExpired(before: Date, limit = 200): Promise<UploadSessionRecord[]> {
  await connectToDatabase();
  const docs = await UploadSessionModel.find({
    expiresAt: { $lte: before },
    status: { $nin: ['ready'] },
  })
    .limit(limit)
    .lean<LeanSession[]>()
    .exec();
  return docs.map(toRecord);
}

/** Upload sessions grouped by status, for the admin system page. */
export async function countByStatus(): Promise<Record<string, number>> {
  await connectToDatabase();
  const rows = await UploadSessionModel.aggregate<{ _id: string; count: number }>([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).exec();

  const out: Record<string, number> = {};
  for (const row of rows) out[row._id] = row.count;
  return out;
}

export async function remove(ids: string[]): Promise<number> {
  const valid = ids.filter(isValidId).map(oid);
  if (valid.length === 0) return 0;
  await connectToDatabase();
  const result = await UploadSessionModel.deleteMany({ _id: { $in: valid } }).exec();
  return result.deletedCount ?? 0;
}
