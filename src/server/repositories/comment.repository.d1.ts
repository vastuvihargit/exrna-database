/**
 * The D1 comment repository.
 *
 * ── Mentions are a second table, so the write is one batch ──────────────────────────────
 *
 * `comment_mentions` replaces the Mongo array, because "mentions of me" is a query and a JSON
 * column cannot be indexed for it. A comment whose mention rows failed to write would notify
 * nobody while looking perfectly normal in the thread — the failure is silent on exactly the
 * side that matters. `batch()` makes both commit or neither.
 *
 * ── Reads join the mentions back in one extra query, not one per comment ────────────────
 *
 * A thread of 200 comments must not become 201 round trips. `listForFile` fetches the comments,
 * then fetches every mention row for that set of ids at once and groups in memory.
 *
 * ── Soft delete is written out ──────────────────────────────────────────────────────────
 *
 * Mongoose applied `deletedAt: null` through a pre-hook. In D1 the condition is spelled into each
 * query, per the project convention — see `schema/_shared.ts`. `purgeForFiles` is the deliberate
 * exception: it must reach soft-deleted rows too, because the file they belong to is being
 * removed for good.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getD1 } from '@/server/db/d1-context';
import { inList } from '@/server/db/d1-bindings';
import { commentMentions, comments } from '@/server/db/schema/collaboration';
import {
  DEFAULT_COMMENT_PAGE,
  MAX_COMMENT_PAGE,
  type CommentRecord,
  type CommentRepository,
  type CreateCommentInput,
} from './comment.repository.contract';

interface CommentRow {
  id: string;
  fileId: string;
  versionId: string | null;
  versionNumber: number | null;
  parentCommentId: string | null;
  authorUserId: string;
  authorName: string;
  body: string;
  isReviewComment: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const recordColumns = {
  id: comments.id,
  fileId: comments.fileId,
  versionId: comments.versionId,
  versionNumber: comments.versionNumber,
  parentCommentId: comments.parentCommentId,
  authorUserId: comments.authorUserId,
  authorName: comments.authorName,
  body: comments.body,
  isReviewComment: comments.isReviewComment,
  resolvedAt: comments.resolvedAt,
  resolvedBy: comments.resolvedBy,
  editedAt: comments.editedAt,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
} as const;

function toRecord(row: CommentRow, mentionedUserIds: string[]): CommentRecord {
  return {
    id: row.id,
    fileId: row.fileId,
    versionId: row.versionId,
    versionNumber: row.versionNumber,
    parentCommentId: row.parentCommentId,
    authorUserId: row.authorUserId,
    authorName: row.authorName,
    body: row.body,
    mentionedUserIds,
    isReviewComment: Boolean(row.isReviewComment),
    resolvedAt: row.resolvedAt === null ? null : new Date(row.resolvedAt),
    resolvedBy: row.resolvedBy,
    editedAt: row.editedAt === null ? null : new Date(row.editedAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/** One query for the whole set — see the header. */
async function mentionsFor(
  db: Awaited<ReturnType<typeof getD1>>,
  commentIds: string[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  if (commentIds.length === 0) return grouped;

  const rows = await db
    .select({ commentId: commentMentions.commentId, userId: commentMentions.userId })
    .from(commentMentions)
    .where(inList(commentMentions.commentId, commentIds));

  for (const row of rows) {
    const existing = grouped.get(row.commentId);
    if (existing) existing.push(row.userId);
    else grouped.set(row.commentId, [row.userId]);
  }
  return grouped;
}

export async function findById(id: string): Promise<CommentRecord | null> {
  const db = await getD1();
  const [row] = await db
    .select(recordColumns)
    .from(comments)
    .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
    .limit(1);

  if (!row) return null;
  const mentions = await mentionsFor(db, [row.id]);
  return toRecord(row as CommentRow, mentions.get(row.id) ?? []);
}

export async function listForFile(
  fileId: string,
  options: { includeResolved?: boolean; limit?: number } = {},
): Promise<CommentRecord[]> {
  const db = await getD1();

  const conditions = [eq(comments.fileId, fileId), isNull(comments.deletedAt)];
  if (!options.includeResolved) conditions.push(isNull(comments.resolvedAt));

  const rows = await db
    .select(recordColumns)
    .from(comments)
    .where(and(...conditions))
    // Oldest first, `id` breaking the tie so a burst of replies keeps a stable order.
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(Math.min(options.limit ?? DEFAULT_COMMENT_PAGE, MAX_COMMENT_PAGE));

  const mentions = await mentionsFor(
    db,
    rows.map((row) => row.id),
  );

  return rows.map((row) => toRecord(row as CommentRow, mentions.get(row.id) ?? []));
}

export async function countForFile(fileId: string): Promise<number> {
  const db = await getD1();
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(comments)
    .where(and(eq(comments.fileId, fileId), isNull(comments.deletedAt)));

  return Number(row?.count ?? 0);
}

export async function create(input: CreateCommentInput): Promise<CommentRecord> {
  const db = await getD1();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const mentioned = [...new Set(input.mentionedUserIds ?? [])];

  const statements: BatchItem<'sqlite'>[] = [
    db.insert(comments).values({
      id,
      organizationId: input.organizationId,
      fileId: input.fileId,
      versionId: input.versionId ?? null,
      versionNumber: input.versionNumber ?? null,
      parentCommentId: input.parentCommentId ?? null,
      authorUserId: input.authorUserId,
      authorName: input.authorName,
      body: input.body,
      isReviewComment: input.isReviewComment ?? false,
      createdAt: now,
      updatedAt: now,
    }),
  ];

  if (mentioned.length > 0) {
    statements.push(
      db
        .insert(commentMentions)
        .values(mentioned.map((userId) => ({ commentId: id, userId })))
        .onConflictDoNothing(),
    );
  }

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

  const created = await findById(id);
  if (!created) {
    // Unreachable unless the batch silently did nothing, which would be a D1 bug rather than a
    // data condition. Surfaced rather than returning a fabricated record.
    throw new Error(`The comment ${id} was written but could not be read back`);
  }
  return created;
}

export async function updateBody(id: string, body: string): Promise<CommentRecord | null> {
  const db = await getD1();
  const now = new Date().toISOString();

  const updated = await db
    .update(comments)
    .set({ body, editedAt: now, updatedAt: now })
    .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
    .returning({ id: comments.id });

  return updated.length > 0 ? findById(id) : null;
}

export async function setResolved(
  id: string,
  resolved: boolean,
  userId: string,
): Promise<CommentRecord | null> {
  const db = await getD1();
  const now = new Date().toISOString();

  const updated = await db
    .update(comments)
    .set(
      resolved
        ? { resolvedAt: now, resolvedBy: userId, updatedAt: now }
        : { resolvedAt: null, resolvedBy: null, updatedAt: now },
    )
    .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
    .returning({ id: comments.id });

  return updated.length > 0 ? findById(id) : null;
}

export async function softDelete(id: string, userId: string): Promise<boolean> {
  const db = await getD1();
  const now = new Date().toISOString();

  const updated = await db
    .update(comments)
    .set({ deletedAt: now, deletedBy: userId, updatedAt: now })
    .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
    .returning({ id: comments.id });

  return updated.length > 0;
}

export async function countRepliesTo(commentId: string): Promise<number> {
  const db = await getD1();
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(comments)
    .where(and(eq(comments.parentCommentId, commentId), isNull(comments.deletedAt)));

  return Number(row?.count ?? 0);
}

export async function purgeForFiles(fileIds: string[]): Promise<number> {
  const unique = [...new Set(fileIds)].filter(Boolean);
  if (unique.length === 0) return 0;

  const db = await getD1();

  /**
   * Replies reference their thread root, so a bare delete can hit the parent first and abort.
   * The self-reference is detached before the delete, in one batch with it.
   *
   * `comment_mentions` cascades, so it needs no step of its own — but that is also why the count
   * comes from `RETURNING` rather than `meta.changes`, which on D1 includes cascaded rows.
   */
  const [, purged] = await db.batch([
    db
      .update(comments)
      .set({ parentCommentId: null })
      .where(inList(comments.fileId, unique)),
    db.delete(comments).where(inList(comments.fileId, unique)).returning({ id: comments.id }),
  ]);

  return Array.isArray(purged) ? purged.length : 0;
}

export const d1CommentRepository: CommentRepository = {
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
