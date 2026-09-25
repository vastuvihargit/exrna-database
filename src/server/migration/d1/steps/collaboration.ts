/**
 * Comments, reviews, approvals, notifications.
 *
 * The review group is the one place where the migration has to preserve a chain rather than a
 * set of rows: **file → exact version → review → approval**. An approval belongs to the version
 * that was reviewed, and nothing about a migration may re-point it at the current version — that
 * would silently transfer sign-off to bytes no reviewer saw. So a review or approval whose
 * version did not migrate is skipped and reported, never re-attached.
 */
import { CommentModel, NotificationModel, ReviewModel } from '@/server/db/models';
import { NOTIFICATION_TYPES } from '@/server/db/models/notification.model';
import {
  REVIEW_DECISIONS,
  REVIEW_REQUEST_STATUSES,
} from '@/server/db/models/review.model';
import {
  bool,
  derivedId,
  enumValue,
  iso,
  nullableStr,
  num,
  oid,
  oidList,
  requiredIso,
  requiredOid,
  str,
} from '../convert';
import { deleteWhere, insert, update, upsert } from '../sql';
import { modelStep } from '../step-helpers';
import type { MigrationStep, Statement } from '../types';
import { timestamps } from './identity';

export const commentsStep: MigrationStep = modelStep({
  name: 'comments',
  description: 'File comments and mentions (thread parents deferred)',
  targets: ['comments', 'comment_mentions'],
  requires: ['files', 'users'],
  publishes: 'comments',
  model: CommentModel as never,
  withDeleted: true,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'comments._id');
    const organizationId = requiredOid(document.organizationId, 'comments.organizationId');
    const fileId = requiredOid(document.fileId, 'comments.fileId');
    const authorUserId = requiredOid(document.authorUserId, 'comments.authorUserId');

    if (!context.known.get('files')?.has(fileId)) {
      return { kind: 'skip', reason: `file ${fileId} was not migrated` };
    }
    const knownUsers = context.known.get('users');
    if (!knownUsers?.has(authorUserId)) {
      return { kind: 'skip', reason: `author ${authorUserId} was not migrated` };
    }

    const versionId = oid(document.versionId);
    const resolvedBy = oid(document.resolvedBy);

    const statements: Statement[] = [
      upsert('comments', {
        id,
        organization_id: organizationId,
        file_id: fileId,
        // A comment pinned to a version keeps its pin, or loses it entirely. Re-pointing it at
        // the current version would attach a remark about v2 to v7.
        version_id:
          versionId && context.known.get('file_versions')?.has(versionId) ? versionId : null,
        version_number: document.versionNumber === null ? null : num(document.versionNumber, 0),
        parent_comment_id: null,
        author_user_id: authorUserId,
        author_name: str(document.authorName),
        body: str(document.body),
        is_review_comment: bool(document.isReviewComment),
        resolved_at: iso(document.resolvedAt),
        resolved_by: resolvedBy && knownUsers.has(resolvedBy) ? resolvedBy : null,
        edited_at: iso(document.editedAt),
        ...timestamps(document),
        deleted_at: iso(document.deletedAt),
        deleted_by: oid(document.deletedBy),
      }),
      deleteWhere('comment_mentions', { comment_id: id }),
    ];

    for (const userId of new Set(oidList(document.mentionedUserIds))) {
      if (!knownUsers.has(userId)) continue;
      statements.push(insert('comment_mentions', { comment_id: id, user_id: userId }));
    }

    return { kind: 'write', statements };
  },
});

/** A reply's parent, once every comment exists. Threads are not `_id`-ordered. */
export const commentBackfillStep: MigrationStep = modelStep({
  name: 'comments-backfill',
  description: 'Comment thread parents',
  targets: ['comments'],
  requires: ['comments'],
  model: CommentModel as never,
  withDeleted: true,
  select: '_id parentCommentId',
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'comments._id');
    const parentCommentId = oid(document.parentCommentId);
    if (!parentCommentId) return { kind: 'write', statements: [] };

    const known = context.known.get('comments');
    return {
      kind: 'write',
      statements: [
        update(
          'comments',
          { parent_comment_id: known?.has(parentCommentId) ? parentCommentId : null },
          { id },
        ),
      ],
    };
  },
});

/**
 * Reviews, their reviewer list, and `decisions[]` as `approvals`.
 *
 * MongoDB embedded the decisions in the review document with `{ _id: false }`, so the approval
 * rows need minted ids. They are **derived** from the review, the reviewer and the decision time
 * rather than random, because a re-run has to produce the same id — otherwise the delta pass
 * writes a second copy of every approval, and the approval history of a file doubles.
 *
 * `ux_reviews_open_per_version` is unique on `version_id` where the status is `pending`. Two
 * pending reviews for one version cannot exist in D1; MongoDB enforced the same partial index,
 * so a corpus that violates it is already inconsistent — the second one is skipped and reported
 * rather than silently closed.
 */
export const reviewsStep: MigrationStep = modelStep({
  name: 'reviews',
  description: 'Review requests, reviewers and approval decisions',
  targets: ['reviews', 'review_reviewers', 'approvals'],
  requires: ['files', 'file-versions', 'users'],
  publishes: 'reviews',
  model: ReviewModel as never,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'reviews._id');
    const organizationId = requiredOid(document.organizationId, 'reviews.organizationId');
    const fileId = requiredOid(document.fileId, 'reviews.fileId');
    const versionId = requiredOid(document.versionId, 'reviews.versionId');
    const requestedBy = requiredOid(document.requestedBy, 'reviews.requestedBy');

    if (!context.known.get('files')?.has(fileId)) {
      return { kind: 'skip', reason: `file ${fileId} was not migrated` };
    }
    // The chain file → exact version → review is the whole point. A review whose version is
    // gone is not re-pointed at another version; it is reported.
    if (!context.known.get('file_versions')?.has(versionId)) {
      return { kind: 'skip', reason: `version ${versionId} was not migrated` };
    }
    const knownUsers = context.known.get('users');
    if (!knownUsers?.has(requestedBy)) {
      return { kind: 'skip', reason: `requester ${requestedBy} was not migrated` };
    }

    const departmentId = oid(document.departmentId);
    const projectId = oid(document.projectId);

    const statements: Statement[] = [
      upsert('reviews', {
        id,
        organization_id: organizationId,
        file_id: fileId,
        version_id: versionId,
        version_number: num(document.versionNumber, 1),
        file_name: str(document.fileName),
        // The checksum the review was raised against, verbatim. It is what "did the content
        // change under this approval?" is answered with.
        version_checksum: str(document.versionChecksum),
        version_revision_id: nullableStr(document.versionRevisionId),
        version_content_modified_at: iso(document.versionContentModifiedAt),
        requested_by: requestedBy,
        requested_by_name: str(document.requestedByName),
        request_note: str(document.requestNote),
        required_approvals: num(document.requiredApprovals, 1),
        status: enumValue(document.status, REVIEW_REQUEST_STATUSES, 'pending'),
        due_at: iso(document.dueAt),
        closed_at: iso(document.closedAt),
        department_id:
          departmentId && context.known.get('departments')?.has(departmentId) ? departmentId : null,
        project_id: projectId && context.known.get('projects')?.has(projectId) ? projectId : null,
        ...timestamps(document),
      }),
      deleteWhere('review_reviewers', { review_id: id }),
      deleteWhere('approvals', { review_id: id }),
    ];

    for (const userId of new Set(oidList(document.reviewerUserIds))) {
      if (!knownUsers.has(userId)) continue;
      statements.push(insert('review_reviewers', { review_id: id, user_id: userId }));
    }

    const decisions = Array.isArray(document.decisions) ? document.decisions : [];
    for (const raw of decisions) {
      const decision = raw as Record<string, unknown>;
      const reviewerUserId = oid(decision.reviewerUserId);
      // An approval is a signature. It cannot be attributed to a user who is not in the target
      // database, and it must not be attributed to nobody either.
      if (!reviewerUserId || !knownUsers.has(reviewerUserId)) continue;

      const decidedAt = requiredIso(
        decision.decidedAt,
        requiredIso(document.createdAt, new Date(0).toISOString()),
      );
      statements.push(
        insert('approvals', {
          id: derivedId('apr_', id, reviewerUserId, decidedAt),
          review_id: id,
          file_id: fileId,
          // The approval is bound to the exact version the review names, which is the invariant
          // the whole review system exists to keep.
          version_id: versionId,
          reviewer_user_id: reviewerUserId,
          reviewer_name: str(decision.reviewerName),
          reviewer_email: str(decision.reviewerEmail),
          decision: enumValue(decision.decision, REVIEW_DECISIONS, 'request_changes'),
          comment: str(decision.comment),
          decided_at: decidedAt,
          ip: str(decision.ip, 'unknown'),
          user_agent: str(decision.userAgent, 'unknown'),
          request_id: nullableStr(decision.requestId),
          created_at: decidedAt,
        }),
      );
    }

    return { kind: 'write', statements };
  },
});

/**
 * Notifications.
 *
 * `dedupe_key` is uniquely indexed in D1 with no partial predicate, which is legal because
 * SQLite treats every NULL in a unique index as distinct — migration 0004 records why the two
 * engines need different index shapes here. A duplicate *non-null* key in the source would still
 * abort the batch, so it is skipped and reported.
 */
export const notificationsStep: MigrationStep = modelStep({
  name: 'notifications',
  description: 'User notifications',
  targets: ['notifications'],
  requires: ['users', 'organizations'],
  model: NotificationModel as never,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'notifications._id');
    const organizationId = requiredOid(document.organizationId, 'notifications.organizationId');
    const userId = requiredOid(document.userId, 'notifications.userId');

    const knownUsers = context.known.get('users');
    if (!knownUsers?.has(userId)) {
      return { kind: 'skip', reason: `recipient ${userId} was not migrated` };
    }
    const actorUserId = oid(document.actorUserId);

    return {
      kind: 'write',
      statements: [
        upsert('notifications', {
          id,
          organization_id: organizationId,
          user_id: userId,
          type: enumValue(document.type, NOTIFICATION_TYPES, 'share.received'),
          actor_user_id: actorUserId && knownUsers.has(actorUserId) ? actorUserId : null,
          actor_name: str(document.actorName),
          entity_type: str(document.entityType),
          entity_id: requiredOid(document.entityId, 'notifications.entityId'),
          entity_label: str(document.entityLabel),
          message: str(document.message),
          read_at: iso(document.readAt),
          dedupe_key: nullableStr(document.dedupeKey),
          ...timestamps(document),
        }),
      ],
    };
  },
});
