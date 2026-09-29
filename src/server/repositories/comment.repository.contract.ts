/**
 * File comments — the shape both engines implement.
 *
 * ── No authorization here ───────────────────────────────────────────────────────────────
 *
 * Like the version and review repositories, this layer decides nothing about who may read a
 * thread. `comment.service.ts` calls `requireFile` first and then checks that the comment belongs
 * to that file — **a comment id is not a capability**. Nothing on this interface takes an `Actor`,
 * which is what makes that impossible to forget by accident: there is no parameter a caller could
 * pass that would make the repository filter, so the caller cannot believe it did.
 *
 * ── A comment belongs to a version ──────────────────────────────────────────────────────
 *
 * `versionId` pins what was being discussed. A comment written against v3 is not about v7, and
 * the field is never rewritten when a new version lands — the same rule reviews follow, for the
 * same reason: the remark referred to specific bytes.
 *
 * ── Soft delete, and the one place it is bypassed ───────────────────────────────────────
 *
 * `softDelete` keeps the thread's shape and keeps the audit trail's subject resolvable. The
 * exception is `purgeForFiles`, called when a file is purged for good: at that point the file
 * itself is gone and a soft-deleted comment would be a permanent orphan pointing at nothing. It
 * therefore removes rows outright, soft-deleted ones included.
 *
 * ── `mentionedUserIds` is a table on D1 ─────────────────────────────────────────────────
 *
 * MongoDB stored an array; D1 has `comment_mentions`, because "mentions of me" is a query and a
 * JSON column cannot be indexed for it. The write touches two tables and must be one unit — a
 * comment whose mention rows failed to write notifies nobody, silently.
 */
import type { ClientSession } from 'mongoose';

/** A Mongoose session on the Mongo path; ignored on D1, which has no interactive transaction. */
export type CommentTx = ClientSession;

export interface CommentRecord {
  id: string;
  fileId: string;
  versionId: string | null;
  versionNumber: number | null;
  parentCommentId: string | null;
  authorUserId: string;
  authorName: string;
  body: string;
  mentionedUserIds: string[];
  isReviewComment: boolean;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCommentInput {
  organizationId: string;
  fileId: string;
  versionId?: string | null;
  versionNumber?: number | null;
  parentCommentId?: string | null;
  authorUserId: string;
  authorName: string;
  body: string;
  mentionedUserIds?: string[];
  isReviewComment?: boolean;
}

export interface CommentRepository {
  findById(id: string): Promise<CommentRecord | null>;
  /**
   * Every comment on a file, oldest first, flat.
   *
   * Not pre-nested: threading is one level deep, so the caller groups by `parentCommentId` in a
   * single pass. Cheaper than an aggregation, and it keeps the ordering rule in one place.
   */
  listForFile(
    fileId: string,
    options?: { includeResolved?: boolean; limit?: number },
  ): Promise<CommentRecord[]>;
  countForFile(fileId: string): Promise<number>;
  create(input: CreateCommentInput, tx?: CommentTx): Promise<CommentRecord>;
  updateBody(id: string, body: string): Promise<CommentRecord | null>;
  setResolved(id: string, resolved: boolean, userId: string): Promise<CommentRecord | null>;
  /** Soft delete. Returns false when the comment was already deleted or absent. */
  softDelete(id: string, userId: string): Promise<boolean>;
  countRepliesTo(commentId: string): Promise<number>;
  /** Hard delete, soft-deleted rows included. Called when the file itself is purged. */
  purgeForFiles(fileIds: string[]): Promise<number>;
}

export const DEFAULT_COMMENT_PAGE = 500;
export const MAX_COMMENT_PAGE = 1000;
