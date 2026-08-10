/**
 * Review repository — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_REVIEWS`.
 *
 * ── This flag does not move alone ───────────────────────────────────────────────────────
 *
 * Approving a review writes three tables in two other modules: `file_versions.is_approved` and
 * the approval binding, and `files.approval_status` / `approved_version_id`. No transaction
 * spans two databases, so reviews on D1 with files or versions on MongoDB is a write that can
 * commit half-way — a file reporting "approved" pointing at a version that does not, or a
 * version marked approved under a review that never closed.
 *
 * `reviewMutationEngine()` in `d1-unit-of-work.ts` refuses that combination rather than
 * attempting it. See §12 of the flag matrix.
 */
import { isD1 } from './data-source';
import { mongoReviewRepository } from './review.repository.mongo';
import { d1ReviewRepository } from './review.repository.d1';
import type {
  CreateReviewInput,
  ListReviewsInput,
  ReviewDecision,
  ReviewDecisionRecord,
  ReviewRecord,
  ReviewRepository,
  ReviewRequestStatus,
  ReviewTx,
} from './review.repository.contract';

export type {
  CreateReviewInput,
  ListReviewsInput,
  ReviewDecision,
  ReviewDecisionRecord,
  ReviewRecord,
  ReviewRepository,
  ReviewRequestStatus,
  ReviewTx,
};

export { mongoReviewRepository, d1ReviewRepository };

function active(): ReviewRepository {
  return isD1('reviews') ? d1ReviewRepository : mongoReviewRepository;
}

export function findById(id: string): Promise<ReviewRecord | null> {
  return active().findById(id);
}

export function findOpenForVersion(versionId: string): Promise<ReviewRecord | null> {
  return active().findOpenForVersion(versionId);
}

export function listForFile(fileId: string): Promise<ReviewRecord[]> {
  return active().listForFile(fileId);
}

export function list(
  input: ListReviewsInput,
): Promise<{ items: ReviewRecord[]; total: number }> {
  return active().list(input);
}

export function create(input: CreateReviewInput, tx?: ReviewTx): Promise<ReviewRecord> {
  return active().create(input, tx);
}

export function appendDecision(
  reviewId: string,
  decision: ReviewDecisionRecord,
  close: { status: ReviewRequestStatus } | null,
  tx?: ReviewTx,
): Promise<ReviewRecord | null> {
  return active().appendDecision(reviewId, decision, close, tx);
}

export function cancel(reviewId: string, tx?: ReviewTx): Promise<boolean> {
  return active().cancel(reviewId, tx);
}

export function cancelOpenForFile(
  fileId: string,
  exceptVersionId?: string,
  tx?: ReviewTx,
): Promise<number> {
  return active().cancelOpenForFile(fileId, exceptVersionId, tx);
}

export function countPendingFor(userId: string): Promise<number> {
  return active().countPendingFor(userId);
}

export function purgeForFiles(fileIds: string[]): Promise<number> {
  return active().purgeForFiles(fileIds);
}

/**
 * Retained because `review.service.ts` and two routes validate a caller-supplied id before
 * using it. The check is Mongo's ObjectId shape, which stays correct after the migration: ids
 * are preserved as D1 TEXT, so a string that is not a valid ObjectId is not one of ours on
 * either engine.
 */
export { isValidId } from './review.repository.mongo';
