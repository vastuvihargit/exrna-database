/**
 * Reviews and approvals — the shape both engines implement.
 *
 * ── The one invariant this module exists to hold ────────────────────────────────────────
 *
 * **An approval belongs to an exact version, and no later version inherits it.**
 *
 * `versionId` is required on every review and is never rewritten. `versionChecksum` is copied
 * at request time so a decision can be checked against the bytes it signed, and
 * `versionRevisionId` / `versionContentModifiedAt` pin what Google Drive held at that moment so
 * a remote edit after submission is detectable rather than invisible. A reviewer signs a set of
 * bytes with a known checksum; uploading v4 cannot retroactively make it "the approved
 * version".
 *
 * ── Structure ───────────────────────────────────────────────────────────────────────────
 *
 * In MongoDB a review is one document with `reviewerUserIds[]` and `decisions[]` embedded. In
 * D1 that is three tables — `reviews`, `review_reviewers`, `approvals` — and `ReviewRecord`
 * reassembles them, so the service and the API response shapes are unchanged by the flag.
 *
 * `decisions` is append-only on both engines. A reviewer who changes their mind adds another
 * decision; nothing rewrites one, so the history of who said what and when survives.
 *
 * ── What is not here ────────────────────────────────────────────────────────────────────
 *
 * **No `Actor`, and therefore no authorization.** Like the version repository, this layer
 * decides nothing about who may see a review. `review.service.ts` calls `requireFile` first and
 * then checks that the review belongs to that file — a review id is not a capability, and
 * `tests/security/review-and-approval.test.ts` is where that boundary is proved.
 *
 * **No multi-table writes.** `appendDecision` closes the request and records the decision, but
 * the *file* and *version* rows that change with it belong to other repositories. On MongoDB
 * the service wraps all three in one session; on D1 one batch cannot span repositories, so
 * `d1-unit-of-work.ts` composes the statements. See `submitReviewAtomically` and
 * `decideReviewAtomically` there.
 */
import type { ClientSession } from 'mongoose';
import type { ReviewDecision, ReviewRequestStatus } from '@/server/db/models/review.model';

export type { ReviewDecision, ReviewRequestStatus };

/** A Mongoose session on the Mongo path; ignored on D1, which has no interactive transaction. */
export type ReviewTx = ClientSession;

export interface ReviewDecisionRecord {
  reviewerUserId: string;
  reviewerName: string;
  reviewerEmail: string;
  decision: ReviewDecision;
  comment: string;
  decidedAt: Date;
  ip: string;
  userAgent: string;
  requestId: string | null;
}

export interface ReviewRecord {
  id: string;
  fileId: string;
  versionId: string;
  versionNumber: number;
  fileName: string;
  versionChecksum: string;
  /** The remote content state when the request was raised. Null for local versions. */
  versionRevisionId: string | null;
  versionContentModifiedAt: Date | null;
  requestedBy: string;
  requestedByName: string;
  requestNote: string;
  reviewerUserIds: string[];
  requiredApprovals: number;
  status: ReviewRequestStatus;
  decisions: ReviewDecisionRecord[];
  dueAt: Date | null;
  closedAt: Date | null;
  departmentId: string | null;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateReviewInput {
  organizationId: string;
  fileId: string;
  versionId: string;
  versionNumber: number;
  fileName: string;
  versionChecksum: string;
  versionRevisionId?: string | null;
  versionContentModifiedAt?: Date | null;
  requestedBy: string;
  requestedByName: string;
  requestNote?: string;
  reviewerUserIds: string[];
  requiredApprovals?: number;
  dueAt?: Date | null;
  departmentId?: string | null;
  projectId?: string | null;
}

export interface ListReviewsInput {
  organizationId: string;
  /** Requests naming this user as a reviewer. */
  reviewerUserId?: string;
  requestedBy?: string;
  status?: ReviewRequestStatus;
  page: number;
  pageSize: number;
}

export interface ReviewRepository {
  findById(id: string): Promise<ReviewRecord | null>;
  findOpenForVersion(versionId: string): Promise<ReviewRecord | null>;
  /** Every review ever raised against a file, newest first — the approval history. */
  listForFile(fileId: string): Promise<ReviewRecord[]>;
  list(input: ListReviewsInput): Promise<{ items: ReviewRecord[]; total: number }>;

  create(input: CreateReviewInput, tx?: ReviewTx): Promise<ReviewRecord>;

  /**
   * Appends a decision and, when the request closes, sets its final status in the same write.
   *
   * The `status = 'pending'` guard is the concurrency control: two reviewers deciding at the
   * same moment cannot both close the request, and the second one's write matches nothing
   * rather than overwriting the first outcome. Returns `null` when nothing matched, which the
   * service reads as "another reviewer closed this first".
   */
  appendDecision(
    reviewId: string,
    decision: ReviewDecisionRecord,
    close: { status: ReviewRequestStatus } | null,
    tx?: ReviewTx,
  ): Promise<ReviewRecord | null>;

  cancel(reviewId: string, tx?: ReviewTx): Promise<boolean>;

  /**
   * Cancels any request still open against a file.
   *
   * Called when a new version lands: a pending review of superseded bytes would let a reviewer
   * approve content that is no longer current, which is exactly the confusion the
   * version-pinned design exists to prevent.
   */
  cancelOpenForFile(fileId: string, exceptVersionId?: string, tx?: ReviewTx): Promise<number>;

  countPendingFor(userId: string): Promise<number>;
  purgeForFiles(fileIds: string[]): Promise<number>;
}
