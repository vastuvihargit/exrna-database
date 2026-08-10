/**
 * The D1 review repository.
 *
 * ── One Mongo document, three tables ────────────────────────────────────────────────────
 *
 *   `reviews`            the request
 *   `review_reviewers`   `reviewerUserIds[]` — who was asked
 *   `approvals`          `decisions[]` — one row per decision, append-only
 *
 * `approvals` is a table rather than a JSON column for two reasons that are not aesthetic. An
 * approval is the closest thing this system has to a signature, and "show me every approval Dr
 * Osei signed in Q3" against a JSON column is a full scan of every review ever raised. And
 * `requiredApprovals` is satisfied by *counting* approve decisions, which against an indexed
 * table is a different proposition from parsing an array in the application.
 *
 * ── The concurrency guard is `status = 'pending'`, in the statement ─────────────────────
 *
 * Two reviewers deciding at the same moment must not both close the request. On MongoDB the
 * guard lives in the `findOneAndUpdate` filter; here it is the `WHERE` clause of a guarded
 * `UPDATE … RETURNING`, and the empty `RETURNING` is how the caller learns it lost the race.
 *
 * The decision row is inserted with the *same* guard, as an `INSERT … SELECT … WHERE EXISTS`,
 * and it is ordered **before** the status update in the batch. That ordering is load-bearing:
 * the update is what makes the request non-pending, so an insert placed after it would see its
 * own guard fail and silently record nothing while the request closed.
 *
 * ── Statement builders, because a decision spans three repositories ─────────────────────
 *
 * Approving does not only close a review. It sets `file_versions.is_approved` and the approval
 * binding on the version, and `files.approval_status` / `approved_version_id` on the file — and
 * a partial commit there is the failure the whole version-pinned design exists to prevent: a
 * file that reports "approved" pointing at a version that does not, or a version marked
 * approved under a review that never closed.
 *
 * D1 has no interactive transaction and one batch cannot span repositories, so the mutations
 * are exposed as *builders* and `d1-unit-of-work.ts` composes them with the file and version
 * halves into a single batch. The self-executing methods beside them satisfy the contract and
 * share the same builders.
 */
import { and, count, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { withBatch, type Database } from '@/server/db/d1';
import { getD1 } from '@/server/db/d1-context';
import { inList } from '@/server/db/d1-bindings';
import { approvals, reviewReviewers, reviews } from '@/server/db/schema/collaboration';
import type {
  CreateReviewInput,
  ListReviewsInput,
  ReviewDecision,
  ReviewDecisionRecord,
  ReviewRecord,
  ReviewRepository,
  ReviewRequestStatus,
} from './review.repository.contract';

type ReviewRow = typeof reviews.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

function nowIso(): string {
  return new Date().toISOString();
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export function newId(): string {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------------ hydration */

function toDecision(row: ApprovalRow): ReviewDecisionRecord {
  return {
    reviewerUserId: row.reviewerUserId,
    reviewerName: row.reviewerName,
    reviewerEmail: row.reviewerEmail,
    decision: row.decision as ReviewDecision,
    comment: row.comment ?? '',
    decidedAt: new Date(row.decidedAt),
    ip: row.ip,
    userAgent: row.userAgent,
    requestId: row.requestId ?? null,
  };
}

/**
 * Reassembles a page of reviews in two extra queries rather than two per row.
 *
 * The reviewer list and the decision list are both ordered deterministically — decisions by
 * when they were made, which is the order the history is read in, and reviewers by user id so
 * a response body does not reshuffle between requests for no reason.
 */
async function hydrate(db: Database, rows: ReviewRow[]): Promise<ReviewRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [reviewerRows, decisionRows] = await Promise.all([
    db
      .select({ reviewId: reviewReviewers.reviewId, userId: reviewReviewers.userId })
      .from(reviewReviewers)
      .where(inList(reviewReviewers.reviewId, ids))
      .orderBy(reviewReviewers.userId),
    db
      .select()
      .from(approvals)
      .where(inList(approvals.reviewId, ids))
      .orderBy(approvals.decidedAt, approvals.id),
  ]);

  const reviewers = new Map<string, string[]>();
  for (const row of reviewerRows) {
    const list = reviewers.get(row.reviewId);
    if (list) list.push(row.userId);
    else reviewers.set(row.reviewId, [row.userId]);
  }

  const decisions = new Map<string, ReviewDecisionRecord[]>();
  for (const row of decisionRows) {
    const list = decisions.get(row.reviewId);
    if (list) list.push(toDecision(row));
    else decisions.set(row.reviewId, [toDecision(row)]);
  }

  return rows.map((row) => ({
    id: row.id,
    fileId: row.fileId,
    versionId: row.versionId,
    versionNumber: row.versionNumber,
    fileName: row.fileName,
    versionChecksum: row.versionChecksum,
    versionRevisionId: row.versionRevisionId ?? null,
    versionContentModifiedAt: row.versionContentModifiedAt
      ? new Date(row.versionContentModifiedAt)
      : null,
    requestedBy: row.requestedBy,
    requestedByName: row.requestedByName,
    requestNote: row.requestNote ?? '',
    reviewerUserIds: reviewers.get(row.id) ?? [],
    requiredApprovals: row.requiredApprovals,
    status: row.status as ReviewRequestStatus,
    decisions: decisions.get(row.id) ?? [],
    dueAt: row.dueAt ? new Date(row.dueAt) : null,
    closedAt: row.closedAt ? new Date(row.closedAt) : null,
    departmentId: row.departmentId ?? null,
    projectId: row.projectId ?? null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }));
}

/* ------------------------------------------------------------------ reads */

export async function findById(id: string): Promise<ReviewRecord | null> {
  if (!id) return null;
  const db = await getD1();
  const [row] = await db.select().from(reviews).where(eq(reviews.id, id)).limit(1);
  if (!row) return null;
  const [record] = await hydrate(db, [row]);
  return record ?? null;
}

export async function findOpenForVersion(versionId: string): Promise<ReviewRecord | null> {
  if (!versionId) return null;
  const db = await getD1();
  const [row] = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.versionId, versionId), eq(reviews.status, 'pending')))
    .limit(1);
  if (!row) return null;
  const [record] = await hydrate(db, [row]);
  return record ?? null;
}

export async function listForFile(fileId: string): Promise<ReviewRecord[]> {
  if (!fileId) return [];
  const db = await getD1();
  const rows = await db
    .select()
    .from(reviews)
    .where(eq(reviews.fileId, fileId))
    .orderBy(desc(reviews.createdAt), desc(reviews.id));
  return hydrate(db, rows);
}

export async function list(
  input: ListReviewsInput,
): Promise<{ items: ReviewRecord[]; total: number }> {
  if (!input.organizationId) return { items: [], total: 0 };
  const db = await getD1();

  const conditions: SQL[] = [eq(reviews.organizationId, input.organizationId)];
  if (input.requestedBy) conditions.push(eq(reviews.requestedBy, input.requestedBy));
  if (input.status) conditions.push(eq(reviews.status, input.status));
  if (input.reviewerUserId) {
    // A correlated EXISTS rather than a join: a join would duplicate a review naming the same
    // person twice, which would corrupt both the page and `total`.
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${reviewReviewers}
                   WHERE ${reviewReviewers.reviewId} = ${reviews.id}
                     AND ${reviewReviewers.userId} = ${input.reviewerUserId})`,
    );
  }

  const where = and(...conditions)!;
  // Built once and used twice, so the page and the count cannot describe different sets.
  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(reviews)
      .where(where)
      .orderBy(desc(reviews.createdAt), desc(reviews.id))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
    db.select({ value: count() }).from(reviews).where(where),
  ]);

  return { items: await hydrate(db, rows), total: totals[0]?.value ?? 0 };
}

export async function countPendingFor(userId: string): Promise<number> {
  if (!userId) return 0;
  const db = await getD1();
  const [row] = await db
    .select({ value: count() })
    .from(reviews)
    .where(
      and(
        eq(reviews.status, 'pending'),
        sql`EXISTS (SELECT 1 FROM ${reviewReviewers}
                     WHERE ${reviewReviewers.reviewId} = ${reviews.id}
                       AND ${reviewReviewers.userId} = ${userId})`,
      ),
    );
  return row?.value ?? 0;
}

/* ------------------------------------------------------------------ statement builders */

/**
 * The request row and its reviewer rows.
 *
 * They land together: a review with no reviewer rows is a request nobody is asked to act on,
 * and it would sit pending forever while its file reports `reviewStatus: 'submitted'`.
 */
export function buildCreateReviewStatements(
  db: Database,
  input: CreateReviewInput,
  id: string,
): BatchItem<'sqlite'>[] {
  const now = nowIso();
  const uniqueReviewers = [...new Set(input.reviewerUserIds.filter(Boolean))];

  const statements: BatchItem<'sqlite'>[] = [
    db.insert(reviews).values({
      id,
      organizationId: input.organizationId,
      fileId: input.fileId,
      versionId: input.versionId,
      versionNumber: input.versionNumber,
      fileName: input.fileName,
      versionChecksum: input.versionChecksum,
      versionRevisionId: input.versionRevisionId ?? null,
      versionContentModifiedAt: iso(input.versionContentModifiedAt),
      requestedBy: input.requestedBy,
      requestedByName: input.requestedByName,
      requestNote: input.requestNote ?? '',
      requiredApprovals: input.requiredApprovals ?? 1,
      status: 'pending',
      dueAt: iso(input.dueAt),
      closedAt: null,
      departmentId: input.departmentId ?? null,
      projectId: input.projectId ?? null,
      createdAt: now,
      updatedAt: now,
    }),
  ];

  if (uniqueReviewers.length > 0) {
    statements.push(
      db.insert(reviewReviewers).values(uniqueReviewers.map((userId) => ({ reviewId: id, userId }))),
    );
  }

  return statements;
}

/**
 * Cancels every request still open against a file, optionally sparing one version.
 *
 * One statement, so a file with six stale requests does not become six statements in a batch
 * that also has to hold the version write.
 */
export function buildCancelOpenForFileStatement(
  db: Database,
  fileId: string,
  exceptVersionId?: string,
): BatchItem<'sqlite'> {
  const now = nowIso();
  const conditions: SQL[] = [eq(reviews.fileId, fileId), eq(reviews.status, 'pending')];
  if (exceptVersionId) conditions.push(ne(reviews.versionId, exceptVersionId));

  return db
    .update(reviews)
    .set({ status: 'cancelled', closedAt: now, updatedAt: now })
    .where(and(...conditions))
    .returning({ id: reviews.id });
}

export function buildCancelStatement(db: Database, reviewId: string): BatchItem<'sqlite'> {
  const now = nowIso();
  return db
    .update(reviews)
    .set({ status: 'cancelled', closedAt: now, updatedAt: now })
    .where(and(eq(reviews.id, reviewId), eq(reviews.status, 'pending')))
    .returning({ id: reviews.id });
}

export interface DecisionPlan {
  statements: BatchItem<'sqlite'>[];
  /**
   * Which statement's `RETURNING` rows decide whether the decision landed.
   *
   * Always the guarded decision INSERT — it carries the same `status = 'pending'` condition as
   * the close, and it is present whether or not the request closes. Callers read
   * `results[guardIndex]` and treat an empty array as "another reviewer got there first".
   */
  guardIndex: number;
}

/**
 * A decision, and the status change that may come with it.
 *
 * The INSERT is conditional on the request still being pending and comes **first** — see the
 * note at the top of this file for why the order is not arbitrary.
 */
export function buildDecisionStatements(
  db: Database,
  reviewId: string,
  fileId: string,
  versionId: string,
  decision: ReviewDecisionRecord,
  close: { status: ReviewRequestStatus } | null,
): DecisionPlan {
  const now = nowIso();

  /**
   * `INSERT … SELECT … WHERE status = 'pending'`, which is how the guard and the write become
   * one statement.
   *
   * Written through `insert().select(sql)` rather than `db.run(sql)` because a fully raw
   * statement **cannot be batched** by this drizzle version: `SQLiteRaw._prepare()` returns
   * itself and carries no `stmt`, so `session.batch()` dereferences `undefined`. Found by the
   * test that approves a review; the failure is a `TypeError` inside drizzle rather than
   * anything that looks like a SQL problem, so it is worth naming here.
   *
   * The value order is the `approvals` table's column order, which is what
   * `buildInsertQuery` emits in the column list. A column added to the schema without a
   * matching expression here shifts every value by one — so the SELECT lists all fourteen
   * explicitly rather than relying on `*`.
   */
  const insertDecision = db
    .insert(approvals)
    .select(
      sql`SELECT ${newId()}, ${reviewId}, ${fileId}, ${versionId}, ${decision.reviewerUserId},
                 ${decision.reviewerName}, ${decision.reviewerEmail}, ${decision.decision},
                 ${decision.comment ?? ''}, ${decision.decidedAt.toISOString()}, ${decision.ip},
                 ${decision.userAgent}, ${decision.requestId ?? null}, ${now}
            FROM ${reviews}
           WHERE ${reviews.id} = ${reviewId} AND ${reviews.status} = 'pending'`,
    )
    .returning({ id: approvals.id });

  const statements: BatchItem<'sqlite'>[] = [insertDecision];

  if (close) {
    statements.push(
      db
        .update(reviews)
        .set({ status: close.status, closedAt: now, updatedAt: now })
        .where(and(eq(reviews.id, reviewId), eq(reviews.status, 'pending')))
        .returning({ id: reviews.id }),
    );
  } else {
    // Not closing, but the request has moved — the dashboard orders by `updated_at`, and a
    // request collecting its second of three approvals should not look untouched.
    statements.push(
      db
        .update(reviews)
        .set({ updatedAt: now })
        .where(and(eq(reviews.id, reviewId), eq(reviews.status, 'pending')))
        .returning({ id: reviews.id }),
    );
  }

  return { statements, guardIndex: 0 };
}

/**
 * Did the guarded statement match?
 *
 * D1 returns one result per batch statement, and drizzle shapes a `RETURNING` result as an
 * array of rows. Anything else — a bare result object from a driver change — is read as "no",
 * because guessing "yes" here would report a decision that may not have been recorded.
 */
export function decisionLanded(results: unknown[], guardIndex: number): boolean {
  const result = results[guardIndex];
  if (Array.isArray(result)) return result.length > 0;
  if (result && typeof result === 'object' && 'results' in result) {
    const rows = (result as { results?: unknown }).results;
    return Array.isArray(rows) && rows.length > 0;
  }
  return false;
}

/* ------------------------------------------------------------------ writes */

export async function create(input: CreateReviewInput): Promise<ReviewRecord> {
  const db = await getD1();
  const id = newId();
  await withBatch(db, buildCreateReviewStatements(db, input, id));
  const created = await findById(id);
  if (!created) throw new Error('The review row disappeared immediately after it was written');
  return created;
}

export async function appendDecision(
  reviewId: string,
  decision: ReviewDecisionRecord,
  close: { status: ReviewRequestStatus } | null,
): Promise<ReviewRecord | null> {
  if (!reviewId) return null;
  const db = await getD1();

  // The decision rows are denormalized with `file_id` and `version_id` so an auditor can query
  // approvals directly, which means the plan needs them — and reading them from the review is
  // also the check that the review exists at all.
  const [row] = await db
    .select({ fileId: reviews.fileId, versionId: reviews.versionId })
    .from(reviews)
    .where(eq(reviews.id, reviewId))
    .limit(1);
  if (!row) return null;

  const plan = buildDecisionStatements(
    db,
    reviewId,
    row.fileId,
    row.versionId,
    decision,
    close,
  );
  const results = await withBatch(db, plan.statements);
  if (!decisionLanded(results, plan.guardIndex)) return null;

  return findById(reviewId);
}

export async function cancel(reviewId: string): Promise<boolean> {
  if (!reviewId) return false;
  const db = await getD1();
  const rows = await db
    .update(reviews)
    .set({ status: 'cancelled', closedAt: nowIso(), updatedAt: nowIso() })
    .where(and(eq(reviews.id, reviewId), eq(reviews.status, 'pending')))
    .returning({ id: reviews.id });
  return rows.length > 0;
}

export async function cancelOpenForFile(
  fileId: string,
  exceptVersionId?: string,
): Promise<number> {
  if (!fileId) return 0;
  const db = await getD1();
  const now = nowIso();
  const conditions: SQL[] = [eq(reviews.fileId, fileId), eq(reviews.status, 'pending')];
  if (exceptVersionId) conditions.push(ne(reviews.versionId, exceptVersionId));

  const rows = await db
    .update(reviews)
    .set({ status: 'cancelled', closedAt: now, updatedAt: now })
    .where(and(...conditions))
    .returning({ id: reviews.id });
  return rows.length;
}

/**
 * Hard delete, for the retention purge only.
 *
 * `review_reviewers` and `approvals` both cascade from `reviews`, so deleting the request takes
 * its reviewers and its decisions with it. That is correct here — the purge is removing the
 * file itself — and it is the one place approvals are ever deleted.
 */
export async function purgeForFiles(fileIds: string[]): Promise<number> {
  const unique = [...new Set(fileIds.filter(Boolean))];
  if (unique.length === 0) return 0;
  const db = await getD1();
  const rows = await db
    .delete(reviews)
    .where(inList(reviews.fileId, unique))
    .returning({ id: reviews.id });
  return rows.length;
}

/* ------------------------------------------------------------------ integrity */

export interface ReviewIntegrityProblem {
  kind:
    | 'approval_without_review'
    | 'approval_version_mismatch'
    | 'closed_without_decision'
    | 'pending_with_closed_at'
    | 'review_without_reviewers'
    | 'cross_organization_file';
  reviewId: string;
  detail: string;
}

/**
 * Read-only validation of the review graph, for migration preparation.
 *
 * Repairs nothing, by design — the same rule as the version validator. A migration that
 * silently corrected a review would be a migration that changed who approved what.
 */
export async function validateReviewGraph(
  organizationId: string,
): Promise<ReviewIntegrityProblem[]> {
  const db = await getD1();
  const problems: ReviewIntegrityProblem[] = [];

  const mine = eq(reviews.organizationId, organizationId);

  // An approval whose version is not the review's. The two are denormalized from the same
  // source, so a disagreement means one of them was written by something other than this code.
  const mismatched = await db
    .select({ reviewId: approvals.reviewId, versionId: approvals.versionId })
    .from(approvals)
    .innerJoin(reviews, eq(reviews.id, approvals.reviewId))
    .where(and(mine, ne(approvals.versionId, reviews.versionId)));
  for (const row of mismatched) {
    problems.push({
      kind: 'approval_version_mismatch',
      reviewId: row.reviewId,
      detail: `an approval names version ${row.versionId}, the review names another`,
    });
  }

  // Closed as approved or rejected with nothing recorded against it.
  const emptyClosed = await db
    .select({ id: reviews.id, status: reviews.status })
    .from(reviews)
    .where(
      and(
        mine,
        inList(reviews.status, ['approved', 'rejected', 'changes_requested']),
        sql`NOT EXISTS (SELECT 1 FROM ${approvals} WHERE ${approvals.reviewId} = ${reviews.id})`,
      ),
    );
  for (const row of emptyClosed) {
    problems.push({
      kind: 'closed_without_decision',
      reviewId: row.id,
      detail: `status is ${row.status} but no decision was recorded`,
    });
  }

  const pendingClosed = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(mine, eq(reviews.status, 'pending'), sql`${reviews.closedAt} IS NOT NULL`));
  for (const row of pendingClosed) {
    problems.push({
      kind: 'pending_with_closed_at',
      reviewId: row.id,
      detail: 'still pending but carries a closed_at',
    });
  }

  const noReviewers = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(
      and(
        mine,
        sql`NOT EXISTS (SELECT 1 FROM ${reviewReviewers}
                         WHERE ${reviewReviewers.reviewId} = ${reviews.id})`,
      ),
    );
  for (const row of noReviewers) {
    problems.push({
      kind: 'review_without_reviewers',
      reviewId: row.id,
      detail: 'nobody is asked to act on this request',
    });
  }

  return problems;
}

export const d1ReviewRepository: ReviewRepository = {
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
