/**
 * Review and approval mutations that span more than one repository, committed as one D1 batch.
 *
 * ── The window this closes ──────────────────────────────────────────────────────────────
 *
 * Approving a review is not one write. It is four:
 *
 *     reviews          status → 'approved', closed_at set
 *     approvals        the decision row appended
 *     file_versions    is_approved, approved_by, approved_at, the Drive approval binding
 *     files            approval_status → 'approved', approved_version_id → this version
 *
 * On MongoDB all four ran inside one session. On D1 there is no interactive transaction, and
 * `withTransaction` opens a *Mongo* session — which does nothing at all for D1 statements. Run
 * as separate batches, a crash or a timeout between them leaves a state that is not
 * self-announcing:
 *
 *   • a review closed as approved while the version still reads `is_approved = 0`, so the
 *     approval badge is absent and a second reviewer can be asked to approve it again;
 *   • worse, the reverse — a version marked approved and bound to a Drive revision under a
 *     review that never closed, which is an approval nobody signed.
 *
 * The second is the one that matters, because the whole version-pinned design exists so that an
 * approval means "these exact bytes were signed by this person at this time". A half-committed
 * approval is a signature with no signatory.
 *
 * ── The shape ───────────────────────────────────────────────────────────────────────────
 *
 *     read what the plan needs   → the review, the file, the version
 *     build every statement      → from three repositories' builders, nothing executed
 *     one db.batch()             → all commit, or none do
 *     inspect the guard          → the decision INSERT's RETURNING decides who won the race
 *
 * ── What this module is not ─────────────────────────────────────────────────────────────
 *
 * **Not an authorization boundary.** `review.service.ts` authorises the file and the reviewer
 * before it calls any of this, exactly as before, and none of these functions takes an `Actor`.
 * What is enforced here is *atomicity* and the `status = 'pending'` race guard.
 *
 * **Separate from `d1-unit-of-work.ts` on purpose.** That module composes hierarchy, lifecycle
 * and version operations and says in its own header that a new operation should arrive as a
 * named function with its own plan type rather than as a generic statement runner. This is that
 * function, in its own file, because reviews touch a different set of tables and share no
 * planning code with a folder move.
 */
import type { BatchItem } from 'drizzle-orm/batch';
import { withBatch } from '@/server/db/d1';
import { getD1 } from '@/server/db/d1-context';
import { AppError, ConflictError } from '@/server/errors/app-error';
import { getLogger } from '@/server/logging/logger';
import { isD1 } from '@/server/repositories/data-source';
import { planFileUpdate } from '@/server/repositories/file.repository.d1';
import { buildVersionFlagsStatement } from '@/server/repositories/file-version.repository.d1';
import {
  buildCancelOpenForFileStatement,
  buildCancelStatement,
  buildCreateReviewStatements,
  buildDecisionStatements,
  decisionLanded,
  findById as findReviewById,
  newId as newReviewId,
} from '@/server/repositories/review.repository.d1';
import type {
  CreateReviewInput,
  ReviewDecisionRecord,
  ReviewRecord,
  ReviewRequestStatus,
} from '@/server/repositories/review.repository.contract';
import type { FilePatch } from '@/server/repositories/file.repository.contract';
import type { VersionPatch } from '@/server/repositories/file-version.repository.contract';

/**
 * Raised when reviews, files and versions are not all on the same database.
 *
 * Fails closed for the same reason `SplitDataSourceVersionError` does. A review decision writes
 * rows in all three modules and no transaction spans two databases, so the write is refused
 * rather than committed half-way.
 *
 * All three flags, not two: an approval binds `files.approved_version_id` *and*
 * `file_versions.is_approved`, so reviews agreeing with files while versions sit elsewhere is
 * just as split as the obvious case.
 */
export class SplitDataSourceReviewError extends AppError {
  constructor(reviews: string, files: string, versions: string) {
    super(
      'CONFLICT',
      'Reviews cannot be updated while the system is switching databases. Please try again ' +
        'later, or contact an administrator.',
      409,
      {
        details: {
          reviews,
          files,
          versions,
          reason:
            `DATA_SOURCE_REVIEWS=${reviews}, DATA_SOURCE_FILES=${files} and ` +
            `DATA_SOURCE_FILE_VERSIONS=${versions}. A review decision writes the review, the ` +
            'version it approves and the file that points at it together, and no transaction ' +
            'spans two databases, so the write is refused rather than committed half-way. Set ' +
            'all three flags to the same value.',
        },
      },
    );
  }
}

/**
 * Which engine a review mutation runs on, or a refusal.
 *
 * Read once per mutation rather than cached: the flags are environment variables and a
 * deployment may change them between requests.
 */
export function reviewMutationEngine(): 'd1' | 'mongo' {
  const reviewsOnD1 = isD1('reviews');
  const filesOnD1 = isD1('files');
  const versionsOnD1 = isD1('fileVersions');

  if (reviewsOnD1 !== filesOnD1 || reviewsOnD1 !== versionsOnD1) {
    const name = (value: boolean) => (value ? 'd1' : 'mongo');
    getLogger().error(
      {
        module: 'reviews',
        reviews: name(reviewsOnD1),
        files: name(filesOnD1),
        versions: name(versionsOnD1),
      },
      'Refusing a review write because reviews, files and versions are on different databases',
    );
    throw new SplitDataSourceReviewError(
      name(reviewsOnD1),
      name(filesOnD1),
      name(versionsOnD1),
    );
  }

  return reviewsOnD1 ? 'd1' : 'mongo';
}

/* ------------------------------------------------------------------ submit */

export interface SubmitReviewAtomicInput {
  review: CreateReviewInput;
  /** Applied to the file in the same batch — `reviewStatus`, `approvalStatus`, `updatedBy`. */
  file: FilePatch;
  /** Applied to the submitted version — normally `{ label: 'under_review' }`. */
  version: VersionPatch;
}

/**
 * Raise a review request, cancel any stale one, and mark the file and version, atomically.
 *
 * The cancellation is part of the same batch rather than a preceding write. Only one version of
 * a file may be under review at a time; if the cancel committed and the create then failed, the
 * file would be left with *no* open review while its `reviewStatus` still said `submitted`, and
 * nothing would ever close it.
 */
export async function submitReviewAtomically(
  input: SubmitReviewAtomicInput,
): Promise<ReviewRecord> {
  const db = await getD1();
  const reviewId = newReviewId();

  const fileStatements = await planFileUpdate(db, input.review.fileId, {}, input.file);
  if (fileStatements === null) throw new ConflictError('That file no longer exists');

  const statements: BatchItem<'sqlite'>[] = [
    // Stale requests first: a request against the version being submitted is spared, so
    // re-submitting the same version is not self-cancelling.
    buildCancelOpenForFileStatement(db, input.review.fileId, input.review.versionId),
    ...buildCreateReviewStatements(db, input.review, reviewId),
    ...fileStatements,
  ];

  const versionStatement = buildVersionFlagsStatement(db, input.review.versionId, input.version);
  if (versionStatement) statements.push(versionStatement);

  await withBatch(db, statements);

  const created = await findReviewById(reviewId);
  if (!created) {
    throw new Error('The review row disappeared immediately after it was written');
  }
  return created;
}

/* ------------------------------------------------------------------ decide */

export interface DecideReviewAtomicInput {
  reviewId: string;
  fileId: string;
  versionId: string;
  decision: ReviewDecisionRecord;
  /** Null while the request stays open and collects more approvals. */
  close: { status: ReviewRequestStatus } | null;
  file: FilePatch;
  version: VersionPatch;
}

/**
 * Record a decision and everything that follows from it, atomically.
 *
 * Returns `null` when the request was no longer pending — another reviewer closed it between
 * the service's read and this write. That is not an error condition here; the service turns it
 * into a `ConflictError` with a message about the other reviewer, exactly as the Mongo path
 * does when `findOneAndUpdate` matches nothing.
 *
 * The whole batch rolls back in that case, so the file and version halves cannot land against a
 * request that never closed.
 */
export async function decideReviewAtomically(
  input: DecideReviewAtomicInput,
): Promise<ReviewRecord | null> {
  const db = await getD1();

  const fileStatements = await planFileUpdate(db, input.fileId, {}, input.file);
  if (fileStatements === null) throw new ConflictError('That file no longer exists');

  const plan = buildDecisionStatements(
    db,
    input.reviewId,
    input.fileId,
    input.versionId,
    input.decision,
    input.close,
  );

  const statements: BatchItem<'sqlite'>[] = [...plan.statements, ...fileStatements];
  const versionStatement = buildVersionFlagsStatement(db, input.versionId, input.version);
  if (versionStatement) statements.push(versionStatement);

  const results = await withBatch(db, statements);

  // `guardIndex` is relative to the decision plan, which is first in the batch, so the index is
  // unchanged. Asserted rather than assumed, because appending the file statements *before* the
  // plan at some later date would silently read the wrong result.
  if (!decisionLanded(results, plan.guardIndex)) return null;

  return findReviewById(input.reviewId);
}

/* ------------------------------------------------------------------ cancel */

export interface CancelReviewAtomicInput {
  reviewId: string;
  fileId: string;
  versionId: string;
  file: FilePatch;
  version: VersionPatch;
}

/**
 * Withdraw a request and return the file and version to draft, atomically.
 *
 * A cancel that committed without the file patch would leave a file reporting `in_review` with
 * nothing open against it — a state the UI offers no way out of, because the "cancel" action is
 * only shown for a request that exists.
 */
export async function cancelReviewAtomically(
  input: CancelReviewAtomicInput,
): Promise<boolean> {
  const db = await getD1();

  const fileStatements = await planFileUpdate(db, input.fileId, {}, input.file);
  if (fileStatements === null) throw new ConflictError('That file no longer exists');

  const statements: BatchItem<'sqlite'>[] = [
    buildCancelStatement(db, input.reviewId),
    ...fileStatements,
  ];
  const versionStatement = buildVersionFlagsStatement(db, input.versionId, input.version);
  if (versionStatement) statements.push(versionStatement);

  const results = await withBatch(db, statements);
  // Statement 0 is the guarded cancel; an empty `RETURNING` means it was already closed.
  return decisionLanded(results, 0);
}
