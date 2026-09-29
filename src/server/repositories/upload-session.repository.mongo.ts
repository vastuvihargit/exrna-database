/**
 * The MongoDB upload-session repository — the existing implementation, moved behind the contract.
 *
 * The only change is that `update` takes a typed patch and wraps it in `$set` here, rather than
 * accepting a Mongo update document from the caller. Behaviour is identical; the difference is
 * that the operator no longer leaks into the service layer, where D1 cannot honour it.
 */
import { Types, type ClientSession } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { UploadSessionModel, type UploadSessionDocument } from '@/server/db/models';
import {
  CLAIMABLE_UPLOAD_STATUSES,
  TERMINAL_UPLOAD_STATUSES,
  type CreateUploadSessionInput,
  type UploadSessionPatch,
  type UploadSessionRecord,
  type UploadSessionRepository,
  type UploadStatus,
} from './upload-session.repository.contract';

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
    externalUploadUri: doc.externalUploadUri ?? null,
    externalStagedId: doc.externalStagedId ?? null,
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
  patch: UploadSessionPatch,
  tx?: ClientSession,
): Promise<UploadSessionRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();

  const set: Record<string, unknown> = { ...patch };
  if (patch.resultFileId !== undefined) {
    set.resultFileId = patch.resultFileId ? oid(patch.resultFileId) : null;
  }
  if (patch.resultVersionId !== undefined) {
    set.resultVersionId = patch.resultVersionId ? oid(patch.resultVersionId) : null;
  }

  const query = UploadSessionModel.findOneAndUpdate({ _id: oid(id) }, { $set: set }, { new: true });
  if (tx) query.session(tx);
  const doc = await query.lean<LeanSession>().exec();
  return doc ? toRecord(doc) : null;
}

export async function markFailed(id: string, reason: string): Promise<void> {
  if (!isValidId(id)) return;
  await connectToDatabase();
  await UploadSessionModel.updateOne(
    { _id: oid(id), status: { $nin: [...TERMINAL_UPLOAD_STATUSES] } },
    { $set: { status: 'failed', failureReason: reason.slice(0, 500) } },
  ).exec();
}

export async function claimForFinalization(
  id: string,
  finalizationKey: string,
): Promise<UploadSessionRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const doc = await UploadSessionModel.findOneAndUpdate(
    { _id: oid(id), status: { $in: [...CLAIMABLE_UPLOAD_STATUSES] }, finalizationKey: null },
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
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const doc = await UploadSessionModel.findOneAndUpdate(
    { _id: oid(id) },
    {
      // `$addToSet` and the matching `$inc` are what make a re-sent chunk idempotent.
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

export const mongoUploadSessionRepository: UploadSessionRepository = {
  findById,
  create,
  update,
  markFailed,
  claimForFinalization,
  recordChunk,
  listExpired,
  countByStatus,
  remove,
};
