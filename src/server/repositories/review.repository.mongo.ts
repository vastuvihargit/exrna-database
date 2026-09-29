/**
 * The MongoDB review repository — a faithful move behind the contract.
 *
 * The only change from the implementation that has always served production is that
 * `ReviewDecisionRecord`, `ReviewRecord`, `CreateReviewInput` and `ListReviewsInput` are now
 * imported from `review.repository.contract.ts` rather than declared here, so the D1
 * implementation cannot drift from them silently.
 */
import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import {
  ReviewModel,
  type ReviewDecision,
  type ReviewDocument,
  type ReviewRequestStatus,
} from '@/server/db/models';
import type {
  CreateReviewInput,
  ListReviewsInput,
  ReviewDecisionRecord,
  ReviewRecord,
  ReviewRepository,
} from './review.repository.contract';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export function isValidId(value: string): boolean {
  return Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value);
}

type LeanReview = ReviewDocument & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

function toRecord(doc: LeanReview): ReviewRecord {
  return {
    id: String(doc._id),
    fileId: String(doc.fileId),
    versionId: String(doc.versionId),
    versionNumber: doc.versionNumber,
    fileName: doc.fileName,
    versionChecksum: doc.versionChecksum,
    versionRevisionId: doc.versionRevisionId ?? null,
    versionContentModifiedAt: doc.versionContentModifiedAt ?? null,
    requestedBy: String(doc.requestedBy),
    requestedByName: doc.requestedByName,
    requestNote: doc.requestNote ?? '',
    reviewerUserIds: (doc.reviewerUserIds ?? []).map(String),
    requiredApprovals: doc.requiredApprovals ?? 1,
    status: doc.status as ReviewRequestStatus,
    decisions: (doc.decisions ?? []).map((decision) => ({
      reviewerUserId: String(decision.reviewerUserId),
      reviewerName: decision.reviewerName,
      reviewerEmail: decision.reviewerEmail,
      decision: decision.decision as ReviewDecision,
      comment: decision.comment ?? '',
      decidedAt: decision.decidedAt ?? doc.createdAt,
      ip: decision.ip ?? 'unknown',
      userAgent: decision.userAgent ?? 'unknown',
      requestId: decision.requestId ?? null,
    })),
    dueAt: doc.dueAt ?? null,
    closedAt: doc.closedAt ?? null,
    departmentId: doc.departmentId ? String(doc.departmentId) : null,
    projectId: doc.projectId ? String(doc.projectId) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function findById(id: string): Promise<ReviewRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const doc = await ReviewModel.findOne({ _id: oid(id) }).lean<LeanReview>().exec();
  return doc ? toRecord(doc) : null;
}

export async function findOpenForVersion(versionId: string): Promise<ReviewRecord | null> {
  if (!isValidId(versionId)) return null;
  await connectToDatabase();
  const doc = await ReviewModel.findOne({ versionId: oid(versionId), status: 'pending' })
    .lean<LeanReview>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function listForFile(fileId: string): Promise<ReviewRecord[]> {
  if (!isValidId(fileId)) return [];
  await connectToDatabase();
  const docs = await ReviewModel.find({ fileId: oid(fileId) })
    .sort({ createdAt: -1 })
    .lean<LeanReview[]>()
    .exec();
  return docs.map(toRecord);
}

export async function list(
  input: ListReviewsInput,
): Promise<{ items: ReviewRecord[]; total: number }> {
  await connectToDatabase();

  const filter: FilterQuery<ReviewDocument> = {
    organizationId: oid(input.organizationId),
  };
  if (input.reviewerUserId && isValidId(input.reviewerUserId)) {
    filter.reviewerUserIds = oid(input.reviewerUserId);
  }
  if (input.requestedBy && isValidId(input.requestedBy)) {
    filter.requestedBy = oid(input.requestedBy);
  }
  if (input.status) filter.status = input.status;

  const [docs, total] = await Promise.all([
    ReviewModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean<LeanReview[]>()
      .exec(),
    ReviewModel.countDocuments(filter).exec(),
  ]);

  return { items: docs.map(toRecord), total };
}

export async function create(
  input: CreateReviewInput,
  session?: ClientSession,
): Promise<ReviewRecord> {
  await connectToDatabase();
  const [doc] = await ReviewModel.create(
    [
      {
        organizationId: oid(input.organizationId),
        fileId: oid(input.fileId),
        versionId: oid(input.versionId),
        versionNumber: input.versionNumber,
        fileName: input.fileName,
        versionChecksum: input.versionChecksum,
        versionRevisionId: input.versionRevisionId ?? null,
        versionContentModifiedAt: input.versionContentModifiedAt ?? null,
        requestedBy: oid(input.requestedBy),
        requestedByName: input.requestedByName,
        requestNote: input.requestNote ?? '',
        reviewerUserIds: input.reviewerUserIds.map(oid),
        requiredApprovals: input.requiredApprovals ?? 1,
        dueAt: input.dueAt ?? null,
        departmentId: input.departmentId ? oid(input.departmentId) : null,
        projectId: input.projectId ? oid(input.projectId) : null,
      },
    ],
    session ? { session } : undefined,
  );
  return toRecord(doc!.toObject() as LeanReview);
}

export async function appendDecision(
  reviewId: string,
  decision: ReviewDecisionRecord,
  close: { status: ReviewRequestStatus } | null,
  session?: ClientSession,
): Promise<ReviewRecord | null> {
  if (!isValidId(reviewId)) return null;
  await connectToDatabase();

  const query = ReviewModel.findOneAndUpdate(
    { _id: oid(reviewId), status: 'pending' },
    {
      $push: {
        decisions: {
          ...decision,
          reviewerUserId: oid(decision.reviewerUserId),
        },
      },
      ...(close ? { $set: { status: close.status, closedAt: new Date() } } : {}),
    },
    { new: true },
  );
  if (session) query.session(session);

  const doc = await query.lean<LeanReview>().exec();
  return doc ? toRecord(doc) : null;
}

export async function cancel(reviewId: string, session?: ClientSession): Promise<boolean> {
  if (!isValidId(reviewId)) return false;
  await connectToDatabase();
  const query = ReviewModel.updateOne(
    { _id: oid(reviewId), status: 'pending' },
    { $set: { status: 'cancelled', closedAt: new Date() } },
  );
  if (session) query.session(session);
  const result = await query.exec();
  return result.modifiedCount > 0;
}

export async function cancelOpenForFile(
  fileId: string,
  exceptVersionId?: string,
  session?: ClientSession,
): Promise<number> {
  if (!isValidId(fileId)) return 0;
  await connectToDatabase();

  const filter: FilterQuery<ReviewDocument> = { fileId: oid(fileId), status: 'pending' };
  if (exceptVersionId && isValidId(exceptVersionId)) {
    filter.versionId = { $ne: oid(exceptVersionId) };
  }

  const query = ReviewModel.updateMany(filter, {
    $set: { status: 'cancelled', closedAt: new Date() },
  });
  if (session) query.session(session);
  const result = await query.exec();
  return result.modifiedCount;
}

export async function countPendingFor(userId: string): Promise<number> {
  if (!isValidId(userId)) return 0;
  await connectToDatabase();
  return ReviewModel.countDocuments({ reviewerUserIds: oid(userId), status: 'pending' }).exec();
}

export async function purgeForFiles(fileIds: string[]): Promise<number> {
  const valid = fileIds.filter(isValidId).map(oid);
  if (valid.length === 0) return 0;
  await connectToDatabase();
  const result = await ReviewModel.deleteMany({ fileId: { $in: valid } }).exec();
  return result.deletedCount ?? 0;
}

export const mongoReviewRepository: ReviewRepository = {
  findById,
  findOpenForVersion,
  listForFile,
  list,
  create,
  appendDecision,
  cancel,
  cancelOpenForFile,
  countPendingFor,
  purgeForFiles,
};
