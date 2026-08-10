/**
 * Comments, reviews, approvals and notifications.
 *
 * The important structural change here is that `reviews.decisions[]` — an embedded array in
 * MongoDB — becomes the `approvals` table the brief asks for. See the note on that table.
 */
import { index, sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import {
  REVIEW_DECISIONS,
  REVIEW_REQUEST_STATUSES,
} from '@/server/db/models/review.model';
import { NOTIFICATION_TYPES } from '@/server/db/models/notification.model';
import { boolean, createdAtColumn, enumText, softDeleteColumns, timestampColumns } from './_shared';
import { departments, organizations, users } from './identity';
import { projects } from './research';
import { files, fileVersions } from './drive';

/* ------------------------------------------------------------------ comments */

export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id),

    /** Which version this was written against — a comment on v3 is not about v7. */
    versionId: text('version_id').references(() => fileVersions.id),
    versionNumber: integer('version_number'),

    /** Null for a thread root; the root for a reply. One level only, by design. */
    parentCommentId: text('parent_comment_id').references((): AnySQLiteColumn => comments.id),

    authorUserId: text('author_user_id')
      .notNull()
      .references(() => users.id),
    /** Denormalized so a thread renders without a join, and survives a rename. */
    authorName: text('author_name').notNull(),

    body: text('body').notNull(),
    isReviewComment: boolean('is_review_comment').notNull().default(false),

    resolvedAt: text('resolved_at'),
    resolvedBy: text('resolved_by').references(() => users.id),
    editedAt: text('edited_at'),

    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    index('ix_comments_thread').on(table.fileId, table.parentCommentId, table.createdAt),
    index('ix_comments_unresolved').on(table.fileId, table.resolvedAt, table.createdAt),
    index('ix_comments_author').on(table.authorUserId, table.createdAt),
  ],
);

export const commentMentions = sqliteTable(
  'comment_mentions',
  {
    commentId: text('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('ux_comment_mentions').on(table.commentId, table.userId),
    // "Mentions of me, newest first" — the reason this is a table and not JSON.
    index('ix_comment_mentions_user').on(table.userId),
  ],
);

/* ------------------------------------------------------------------ reviews */

export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),

    fileId: text('file_id')
      .notNull()
      .references(() => files.id),
    /**
     * Immutable, required, and the whole reason the approval story is defensible: a reviewer
     * signs off on an exact set of bytes with a known checksum, and no later upload can
     * retroactively become "the approved version".
     */
    versionId: text('version_id')
      .notNull()
      .references(() => fileVersions.id),
    versionNumber: integer('version_number').notNull(),
    /** Denormalized so the pending-review dashboard renders without a join. */
    fileName: text('file_name').notNull(),
    /** Copied at request time so a decision can be checked against the bytes it signed. */
    versionChecksum: text('version_checksum').notNull(),

    /**
     * The remote content state when the review was raised.
     *
     * Null for every local version and every review raised before Phase 8 of the storage
     * work, and a null reads as "nothing remote to check" rather than as a mismatch — so
     * existing approvals stay valid through the migration with no back-fill.
     */
    versionRevisionId: text('version_revision_id'),
    versionContentModifiedAt: text('version_content_modified_at'),

    requestedBy: text('requested_by')
      .notNull()
      .references(() => users.id),
    requestedByName: text('requested_by_name').notNull(),
    requestNote: text('request_note').notNull().default(''),

    /** How many approvals close the request. A study needing two signatures sets 2. */
    requiredApprovals: integer('required_approvals').notNull().default(1),

    status: enumText('status', REVIEW_REQUEST_STATUSES).notNull().default('pending'),

    dueAt: text('due_at'),
    closedAt: text('closed_at'),

    departmentId: text('department_id').references(() => departments.id),
    projectId: text('project_id').references(() => projects.id),

    ...timestampColumns,
  },
  (table) => [
    index('ix_reviews_file').on(table.fileId, table.createdAt),
    index('ix_reviews_org_status').on(table.organizationId, table.status, table.createdAt),
    index('ix_reviews_requester').on(table.requestedBy, table.status, table.createdAt),

    /**
     * One open request per version.
     *
     * Partial on `status = 'pending'`, reproducing the Mongo index. A second open request
     * would let two reviewers approve the same bytes through different requests and produce
     * two conflicting histories.
     */
    uniqueIndex('ux_reviews_open_per_version')
      .on(table.versionId)
      .where(sql`status = 'pending'`),
  ],
);

/** `reviews.reviewerUserIds[]` — who was asked. */
export const reviewReviewers = sqliteTable(
  'review_reviewers',
  {
    reviewId: text('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    uniqueIndex('ux_review_reviewers').on(table.reviewId, table.userId),
    // The pending-review dashboard: "what is waiting on me".
    index('ix_review_reviewers_user').on(table.userId),
  ],
);

/* ------------------------------------------------------------------ approvals */

/**
 * `reviews.decisions[]` — one row per decision. The brief's `approvals` table.
 *
 * ── Why this becomes a table ────────────────────────────────────────────────────────────
 *
 * In MongoDB, decisions were embedded because they are meaningless outside their request,
 * bounded in number, and every read of a request wants them. All three are still true, so
 * embedding was right there and JSON would not be *wrong* here — but two things make a table
 * better in D1:
 *
 *   1. An approval is the closest thing this system has to a signature. "Show me every
 *      approval Dr Osei signed in Q3" is an audit question, and against a JSON column it is a
 *      full scan of every review ever raised.
 *   2. `requiredApprovals` is satisfied by counting approve decisions. `COUNT(*)` against an
 *      indexed table is a different proposition from parsing an array in the application.
 *
 * ── Append-only ─────────────────────────────────────────────────────────────────────────
 *
 * The service never rewrites a decision; a reviewer who changes their mind adds another, so
 * the history of who said what and when survives. There is deliberately no `updated_at` and
 * no soft delete. Phase 3 keeps the repository surface to append and query only, matching
 * how `audit_logs` and `stock_transactions` are handled.
 */
export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    reviewId: text('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    /**
     * Denormalized from the review so an auditor can query approvals directly without
     * joining, and so the row survives as a self-contained record of what was signed.
     */
    fileId: text('file_id')
      .notNull()
      .references(() => files.id),
    versionId: text('version_id')
      .notNull()
      .references(() => fileVersions.id),

    reviewerUserId: text('reviewer_user_id')
      .notNull()
      .references(() => users.id),
    reviewerName: text('reviewer_name').notNull(),
    reviewerEmail: text('reviewer_email').notNull(),

    decision: enumText('decision', REVIEW_DECISIONS).notNull(),
    comment: text('comment').notNull().default(''),
    decidedAt: text('decided_at').notNull(),

    /** §15 of the brief: "who, from where, on what" is what makes an approval hold up. */
    ip: text('ip').notNull().default('unknown'),
    userAgent: text('user_agent').notNull().default('unknown'),
    requestId: text('request_id'),

    ...createdAtColumn,
  },
  (table) => [
    index('ix_approvals_review').on(table.reviewId, table.decidedAt),
    index('ix_approvals_reviewer').on(table.reviewerUserId, table.decidedAt),
    index('ix_approvals_version').on(table.versionId),
    index('ix_approvals_file').on(table.fileId, table.decidedAt),
  ],
);

/* ------------------------------------------------------------------ notifications */

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    /** The recipient. One row per person, never one row with a recipient list. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id),

    type: enumText('type', NOTIFICATION_TYPES).notNull(),

    actorUserId: text('actor_user_id').references(() => users.id),
    actorName: text('actor_name').notNull().default(''),

    /** Polymorphic — a file, folder, review or comment. Not a foreign key. */
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    /** A label, never content: the body stays behind the permission check on the file. */
    entityLabel: text('entity_label').notNull().default(''),

    message: text('message').notNull(),
    readAt: text('read_at'),

    /**
     * Set only by Queue consumers, where delivery is at-least-once.
     *
     * A unique partial index in migration 0004 turns a redelivery into a no-op instead of a
     * duplicate row. NULL means "written inline from a request", which cannot retry and so has
     * nothing to deduplicate — see the migration for why those rows are not backfilled.
     */
    dedupeKey: text('dedupe_key'),

    ...timestampColumns,
  },
  (table) => [
    // The unread badge and the list are the same query shape; this index serves both.
    index('ix_notifications_unread').on(table.userId, table.readAt, table.createdAt),
    index('ix_notifications_user').on(table.userId, table.createdAt),
    index('ix_notifications_entity').on(table.entityType, table.entityId),
    /**
     * Not partial, deliberately: SQLite treats every NULL as distinct in a unique index, so the
     * many inline-written rows that carry NULL do not collide. Migration 0004 explains why the
     * MongoDB index has to be partial and this one must not be.
     */
    uniqueIndex('ux_notifications_dedupe_key').on(table.dedupeKey),
  ],
);
