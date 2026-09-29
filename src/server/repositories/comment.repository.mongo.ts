/**
 * The MongoDB comment repository — the existing implementation, moved behind the contract.
 *
 * Behaviour is unchanged. `isValidId` stays exported because `comment.service.ts` imports it to
 * reject a malformed id before touching the database.
 */
import { Types, type ClientSession } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { CommentModel, type CommentDocument } from '@/server/db/models';
import {
  DEFAULT_COMMENT_PAGE,
  MAX_COMMENT_PAGE,
  type CommentRecord,
  type CommentRepository,
  type CreateCommentInput,
} from './comment.repository.contract';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export function isValidId(value: string): boolean {
  return Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value);
}

type LeanComment = CommentDocument & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

function toRecord(doc: LeanComment): CommentRecord {
  return {
    id: String(doc._id),
    fileId: String(doc.fileId),
    versionId: doc.versionId ? String(doc.versionId) : null,
    versionNumber: doc.versionNumber ?? null,
    parentCommentId: doc.parentCommentId ? String(doc.parentCommentId) : null,
    authorUserId: String(doc.authorUserId),
    authorName: doc.authorName,
    body: doc.body,
    mentionedUserIds: (doc.mentionedUserIds ?? []).map(String),
    isReviewComment: Boolean(doc.isReviewComment),
    resolvedAt: doc.resolvedAt ?? null,
    resolvedBy: doc.resolvedBy ? String(doc.resolvedBy) : null,
    editedAt: doc.editedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function findById(id: string): Promise<CommentRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const doc = await CommentModel.findOne({ _id: oid(id) }).lean<LeanComment>().exec();
  return doc ? toRecord(doc) : null;
}

export async function listForFile(
  fileId: string,
  options: { includeResolved?: boolean; limit?: number } = {},
): Promise<CommentRecord[]> {
  if (!isValidId(fileId)) return [];
  await connectToDatabase();

  const filter: Record<string, unknown> = { fileId: oid(fileId) };
  if (!options.includeResolved) filter.resolvedAt = null;

  const docs = await CommentModel.find(filter)
    .sort({ createdAt: 1, _id: 1 })
    .limit(Math.min(options.limit ?? DEFAULT_COMMENT_PAGE, MAX_COMMENT_PAGE))
    .lean<LeanComment[]>()
    .exec();
  return docs.map(toRecord);
}

export async function countForFile(fileId: string): Promise<number> {
  if (!isValidId(fileId)) return 0;
  await connectToDatabase();
  return CommentModel.countDocuments({ fileId: oid(fileId) }).exec();
}

export async function create(
  input: CreateCommentInput,
  tx?: ClientSession,
): Promise<CommentRecord> {
  await connectToDatabase();
  const [doc] = await CommentModel.create(
    [
      {
        organizationId: oid(input.organizationId),
        fileId: oid(input.fileId),
        versionId: input.versionId ? oid(input.versionId) : null,
        versionNumber: input.versionNumber ?? null,
        parentCommentId: input.parentCommentId ? oid(input.parentCommentId) : null,
        authorUserId: oid(input.authorUserId),
        authorName: input.authorName,
        body: input.body,
        mentionedUserIds: (input.mentionedUserIds ?? []).map(oid),
        isReviewComment: input.isReviewComment ?? false,
      },
    ],
    tx ? { session: tx } : undefined,
  );
  return toRecord(doc!.toObject() as LeanComment);
}

export async function updateBody(id: string, body: string): Promise<CommentRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const doc = await CommentModel.findOneAndUpdate(
    { _id: oid(id) },
    { $set: { body, editedAt: new Date() } },
    { new: true },
  )
    .lean<LeanComment>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function setResolved(
  id: string,
  resolved: boolean,
  userId: string,
): Promise<CommentRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const doc = await CommentModel.findOneAndUpdate(
    { _id: oid(id) },
    {
      $set: resolved
        ? { resolvedAt: new Date(), resolvedBy: oid(userId) }
        : { resolvedAt: null, resolvedBy: null },
    },
    { new: true },
  )
    .lean<LeanComment>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function softDelete(id: string, userId: string): Promise<boolean> {
  if (!isValidId(id)) return false;
  await connectToDatabase();
  const result = await CommentModel.updateOne(
    { _id: oid(id), deletedAt: null },
    { $set: { deletedAt: new Date(), deletedBy: oid(userId) } },
  ).exec();
  return result.matchedCount > 0;
}

export async function countRepliesTo(commentId: string): Promise<number> {
  if (!isValidId(commentId)) return 0;
  await connectToDatabase();
  return CommentModel.countDocuments({ parentCommentId: oid(commentId) }).exec();
}

export async function purgeForFiles(fileIds: string[]): Promise<number> {
  const valid = fileIds.filter(isValidId).map(oid);
  if (valid.length === 0) return 0;
  await connectToDatabase();
  const result = await CommentModel.deleteMany({ fileId: { $in: valid } })
    .setOptions({ withDeleted: true })
    .exec();
  return result.deletedCount ?? 0;
}

export const mongoCommentRepository: CommentRepository = {
  findById,
  listForFile,
  countForFile,
  create,
  updateBody,
  setResolved,
  softDelete,
  countRepliesTo,
  purgeForFiles,
};
