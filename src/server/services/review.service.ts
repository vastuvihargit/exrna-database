/**
 * Review and approval.
 *
 * The workflow is Draft → Submitted → (Changes requested → Submitted)* → Approved /
 * Rejected, and four rules hold it together:
 *
 *  1. **A review is of a version, never of a file.** The request pins `versionId` and
 *     copies its checksum. "Which bytes did they sign?" is answerable forever, and no
 *     later upload can quietly inherit an approval.
 *
 *  2. **Nobody approves their own work.** Enforced explicitly here, not merely by
 *     omitting `review.approve` from `OWNER_PERMISSIONS` — a scientist who also holds a
 *     department-scoped approver role would otherwise satisfy the permission check on
 *     their own file, and the permission layer has no concept of "but it's yours".
 *
 *  3. **An approved version is read-only.** Enforced in `file.service` for renames,
 *     metadata and deletion; here it means a new upload cancels any open review and
 *     resets the file's approval, so an approved file that changes stops being approved
 *     rather than silently keeping the badge.
 *
 *  4. **Every decision is evidence.** Reviewer, decision, comment, version id, timestamp,
 *     IP and user agent are all stored, and none of it is ever rewritten — a reviewer who
 *     changes their mind adds a decision, they do not edit one.
 *
 *  5. **An approval covers a state, not a name.** Rule 1 was a complete guarantee while
 *     bytes lived on our own disk, because a version's content is immutable there. Content
 *     in a Shared Drive has no such property, so a request also pins the Drive revision and
 *     an approval records the revision it was granted against. `approval-integrity.service`
 *     is what notices when that revision stops being the current one.
 */
import { withTransaction } from '@/server/db/connection';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/server/errors/app-error';
import type { Actor } from '@/server/permissions/actor';
import { auditService } from '@/server/audit/audit.service';
import * as activityRepository from '@/server/repositories/activity.repository';
import * as commentRepository from '@/server/repositories/comment.repository';
import * as fileRepository from '@/server/repositories/file.repository';
import * as versionRepository from '@/server/repositories/file-version.repository';
import * as notificationRepository from '@/server/repositories/notification.repository';
import * as reviewRepository from '@/server/repositories/review.repository';
import type { ReviewRecord } from '@/server/repositories/review.repository';
import * as userRepository from '@/server/repositories/user.repository';
import type { ReviewDecision } from '@/server/db/models';
import type { RequestMeta } from '@/server/http/request-meta';
import {
  approvalBindingUpdate,
  fingerprintForReview,
} from './approval-integrity.service';
import { fileCan, requireFile, type FileContext } from './file-access';

export interface ReviewView extends ReviewRecord {
  /** What the *viewer* may do with this request. */
  capabilities: { canDecide: boolean; canCancel: boolean };
  approvalsSoFar: number;
}

export interface SubmitReviewInput {
  reviewerUserIds: string[];
  note?: string;
  requiredApprovals?: number;
  dueAt?: Date | null;
  /** Defaults to the current version. */
  versionId?: string;
}

export async function submitForReview(
  actor: Actor,
  fileId: string,
  input: SubmitReviewInput,
  meta: RequestMeta,
): Promise<ReviewView> {
  const context = await requireFile(actor, fileId, 'review.submit');

  if (context.file.approvalStatus === 'approved') {
    throw new ConflictError(
      'This file is already approved. Upload a new version if it needs to change — the approved version stays available.',
      'FILE_LOCKED_APPROVED',
    );
  }

  const versionId = input.versionId ?? context.file.currentVersionId;
  if (!versionId) throw new ConflictError('This file has no uploaded version to review');

  const version = await versionRepository.findById(versionId);
  if (!version || version.fileId !== fileId) throw new NotFoundError('That version does not belong to this file');

  const existing = await reviewRepository.findOpenForVersion(versionId);
  if (existing) {
    throw new ConflictError('That version is already out for review', 'CONFLICT');
  }

  const reviewers = await resolveReviewers(actor, context, input.reviewerUserIds);
  const requiredApprovals = Math.min(input.requiredApprovals ?? 1, reviewers.length);

  // Pins what Drive currently holds, so a decision can be checked against the state that was
  // actually submitted. Null for a local version, whose bytes cannot change anyway. Read
  // before the transaction: a Drive hiccup must not stop somebody submitting their work.
  const submitted = await fingerprintForReview(versionId);

  const review = await withTransaction(async (session) => {
    // A pending review of superseded bytes would let someone approve content that is no
    // longer current. Only one version of a file can be under review at a time.
    await reviewRepository.cancelOpenForFile(fileId, versionId, session);

    const created = await reviewRepository.create(
      {
        organizationId: actor.organizationId,
        fileId,
        versionId,
        versionNumber: version.versionNumber,
        fileName: context.file.displayName,
        versionChecksum: version.checksumSha256,
        versionRevisionId: submitted.revisionId,
        versionContentModifiedAt: submitted.contentModifiedAt,
        requestedBy: actor.userId,
        requestedByName: actor.name,
        ...(input.note ? { requestNote: input.note } : {}),
        reviewerUserIds: reviewers.map((reviewer) => reviewer.id),
        requiredApprovals,
        dueAt: input.dueAt ?? null,
        departmentId: context.file.departmentId,
        projectId: context.file.projectId,
      },
      session,
    );

    await fileRepository.updateById(
      fileId,
      { reviewStatus: 'submitted', approvalStatus: 'pending', updatedBy: actor.userId },
      session,
    );

    await versionRepository.updateFlags(versionId, { $set: { label: 'under_review' } }, session);

    return created;
  });

  await auditService.recordForActor(actor, meta, {
    action: 'file.review_requested',
    entityType: 'file',
    entityId: fileId,
    entityLabel: context.file.displayName,
    newValue: {
      reviewId: review.id,
      versionId,
      versionNumber: version.versionNumber,
      versionChecksum: version.checksumSha256,
      reviewerUserIds: review.reviewerUserIds,
      requiredApprovals,
    },
    severity: 'notice',
  });

  void activityRepository
    .append({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorName: actor.name,
      action: 'file.review_requested',
      entityType: 'file',
      entityId: fileId,
      entityLabel: context.file.displayName,
      detail: `submitted version ${version.versionNumber} for review`,
      contextFolderIds: context.file.folderPathAncestors,
      departmentId: context.file.departmentId,
      projectId: context.file.projectId,
    })
    .catch(() => undefined);

  void notificationRepository
    .createMany(
      reviewers.map((reviewer) => ({
        organizationId: actor.organizationId,
        userId: reviewer.id,
        type: 'review.requested' as const,
        actorUserId: actor.userId,
        actorName: actor.name,
        entityType: 'file',
        entityId: fileId,
        entityLabel: context.file.displayName,
        message: `${actor.name} asked you to review "${context.file.displayName}" (version ${version.versionNumber})`,
      })),
    )
    .catch(() => undefined);

  return toView(actor, review, context);
}

export interface DecideInput {
  decision: ReviewDecision;
  comment?: string;
}

export async function decide(
  actor: Actor,
  reviewId: string,
  input: DecideInput,
  meta: RequestMeta,
): Promise<ReviewView> {
  const review = await reviewRepository.findById(reviewId);
  if (!review) throw new NotFoundError();

  // Approving needs `review.approve`; requesting changes or rejecting needs only
  // `review.perform` — a reviewer who can raise concerns need not be able to sign off.
  const permission = input.decision === 'approve' ? 'review.approve' : 'review.perform';
  const context = await requireFile(actor, review.fileId, permission);

  if (review.status !== 'pending') {
    throw new ConflictError(`This review is already ${review.status}`);
  }

  if (!review.reviewerUserIds.includes(actor.userId)) {
    throw new ForbiddenError('You are not a reviewer on this request');
  }

  // Rule 2. Checked here rather than relying on the permission layer, which has no
  // concept of "but it's your own file" — a scientist holding a department approver role
  // would otherwise pass the permission check on their own submission.
  if (review.requestedBy === actor.userId) {
    throw new ForbiddenError('You cannot decide on a review you submitted yourself');
  }
  if (context.file.ownerId === actor.userId) {
    throw new ForbiddenError('You cannot approve or reject your own file');
  }

  if (review.decisions.some((decision) => decision.reviewerUserId === actor.userId)) {
    throw new ConflictError('You have already recorded a decision on this review');
  }

  // The bytes must still be the bytes that were submitted. If they are not, something
  // has gone wrong at a level this service cannot reason about, and signing anyway would
  // produce an approval record that means nothing.
  const version = await versionRepository.findById(review.versionId);
  if (!version || version.checksumSha256 !== review.versionChecksum) {
    throw new ConflictError(
      'The version under review no longer matches what was submitted. Ask for a fresh review request.',
      'VERSION_MOVED',
    );
  }

  /**
   * The checksum above proves the *record* is unchanged. For content in the Shared Drive
   * that is not the same as the content being unchanged — a Google Doc can be rewritten
   * between the request and the decision, and nothing in the version document moves when it
   * is. So the live revision is read again and compared to the one that was submitted.
   *
   * Only on approval. Rejecting or requesting changes on a document that has since been
   * edited is perfectly sensible — the reviewer has seen enough — and blocking it would
   * leave the request stuck open with no way to close it.
   */
  const current = await fingerprintForReview(review.versionId);
  if (
    input.decision === 'approve' &&
    review.versionRevisionId &&
    current.revisionId &&
    current.revisionId !== review.versionRevisionId
  ) {
    throw new ConflictError(
      'This document has changed since it was sent for review. Ask for a fresh review request so the approval covers what is there now.',
      'CONTENT_CHANGED',
    );
  }

  const decisionRecord = {
    reviewerUserId: actor.userId,
    reviewerName: actor.name,
    reviewerEmail: actor.email,
    decision: input.decision,
    comment: input.comment?.trim() ?? '',
    decidedAt: new Date(),
    ip: meta.ip,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  };

  const approvals =
    review.decisions.filter((entry) => entry.decision === 'approve').length +
    (input.decision === 'approve' ? 1 : 0);

  // A single rejection or change request closes the round: there is no point collecting
  // the remaining approvals for bytes that are going to be replaced.
  const close =
    input.decision === 'reject'
      ? ({ status: 'rejected' } as const)
      : input.decision === 'request_changes'
        ? ({ status: 'changes_requested' } as const)
        : approvals >= review.requiredApprovals
          ? ({ status: 'approved' } as const)
          : null;

  const updated = await withTransaction(async (session) => {
    const result = await reviewRepository.appendDecision(reviewId, decisionRecord, close, session);
    // The repository filters on `status: 'pending'`, so a null here means another
    // reviewer closed the request between our read and our write.
    if (!result) {
      throw new ConflictError('Another reviewer closed this request first');
    }

    if (close?.status === 'approved') {
      await versionRepository.updateFlags(
        review.versionId,
        {
          $set: {
            label: 'approved',
            isApproved: true,
            approvedBy: actor.userId,
            approvedAt: new Date(),
            // Records the exact remote state this signature covers, so a later change to it
            // is detectable rather than invisible. All nulls for a local version.
            ...approvalBindingUpdate(current),
          },
        },
        session,
      );
      await fileRepository.updateById(
        review.fileId,
        {
          reviewStatus: 'approved',
          approvalStatus: 'approved',
          approvedVersionId: review.versionId,
          updatedBy: actor.userId,
        },
        session,
      );
    } else if (close?.status === 'rejected') {
      await versionRepository.updateFlags(review.versionId, { $set: { label: 'draft' } }, session);
      await fileRepository.updateById(
        review.fileId,
        { reviewStatus: 'rejected', approvalStatus: 'rejected', updatedBy: actor.userId },
        session,
      );
    } else if (close?.status === 'changes_requested') {
      await versionRepository.updateFlags(
        review.versionId,
        { $set: { label: 'changes_requested' } },
        session,
      );
      await fileRepository.updateById(
        review.fileId,
        { reviewStatus: 'changes_requested', approvalStatus: 'none', updatedBy: actor.userId },
        session,
      );
    } else {
      await fileRepository.updateById(
        review.fileId,
        { reviewStatus: 'in_review', updatedBy: actor.userId },
        session,
      );
    }

    return result;
  });

  // The reviewer's remarks become a comment on the file so they sit alongside the rest of
  // the discussion rather than only inside a review record nobody thinks to open.
  if (decisionRecord.comment) {
    await commentRepository
      .create({
        organizationId: actor.organizationId,
        fileId: review.fileId,
        versionId: review.versionId,
        versionNumber: review.versionNumber,
        authorUserId: actor.userId,
        authorName: actor.name,
        body: decisionRecord.comment,
        isReviewComment: true,
      })
      .catch(() => undefined);
  }

  await auditService.recordForActor(actor, meta, {
    action: input.decision === 'approve' ? 'file.approve' : 'file.reject',
    entityType: 'file',
    entityId: review.fileId,
    entityLabel: review.fileName,
    newValue: {
      reviewId,
      decision: input.decision,
      versionId: review.versionId,
      versionNumber: review.versionNumber,
      versionChecksum: review.versionChecksum,
      outcome: close?.status ?? 'pending',
    },
    reason: decisionRecord.comment || undefined,
    severity: 'notice',
  });

  void activityRepository
    .append({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorName: actor.name,
      action: input.decision === 'approve' ? 'file.approve' : 'file.reject',
      entityType: 'file',
      entityId: review.fileId,
      entityLabel: review.fileName,
      detail: `${input.decision.replace('_', ' ')} on version ${review.versionNumber}`,
      contextFolderIds: context.file.folderPathAncestors,
      departmentId: context.file.departmentId,
      projectId: context.file.projectId,
    })
    .catch(() => undefined);

  void notificationRepository
    .create({
      organizationId: actor.organizationId,
      userId: review.requestedBy,
      type: 'review.decided',
      actorUserId: actor.userId,
      actorName: actor.name,
      entityType: 'file',
      entityId: review.fileId,
      entityLabel: review.fileName,
      message:
        close?.status === 'approved'
          ? `${actor.name} approved "${review.fileName}" version ${review.versionNumber}`
          : close?.status === 'rejected'
            ? `${actor.name} rejected "${review.fileName}" version ${review.versionNumber}`
            : close?.status === 'changes_requested'
              ? `${actor.name} requested changes to "${review.fileName}" version ${review.versionNumber}`
              : `${actor.name} recorded a decision on "${review.fileName}"`,
    })
    .catch(() => undefined);

  return toView(actor, updated, context);
}

export async function cancelReview(
  actor: Actor,
  reviewId: string,
  meta: RequestMeta,
): Promise<void> {
  const review = await reviewRepository.findById(reviewId);
  if (!review) throw new NotFoundError();

  const context = await requireFile(actor, review.fileId, 'file.view');

  // The submitter withdraws their own request; an access manager can clear one that has
  // been left open by someone who has since left.
  if (review.requestedBy !== actor.userId && !fileCan(actor, 'access.manage', context)) {
    throw new ForbiddenError('Only the person who requested this review can withdraw it');
  }

  if (review.status !== 'pending') {
    throw new ConflictError(`This review is already ${review.status}`);
  }

  await withTransaction(async (session) => {
    await reviewRepository.cancel(reviewId, session);
    await versionRepository.updateFlags(review.versionId, { $set: { label: 'draft' } }, session);
    await fileRepository.updateById(
      review.fileId,
      { reviewStatus: 'draft', approvalStatus: 'none', updatedBy: actor.userId },
      session,
    );
  });

  await auditService.recordForActor(actor, meta, {
    action: 'file.review_requested',
    entityType: 'file',
    entityId: review.fileId,
    entityLabel: review.fileName,
    previousValue: { status: 'pending', reviewId },
    newValue: { status: 'cancelled' },
    reason: 'review withdrawn',
    severity: 'notice',
  });
}

/* ------------------------------------------------------------------- reads */

export async function listPendingForMe(
  actor: Actor,
  input: { page: number; pageSize: number },
): Promise<{ items: ReviewView[]; total: number }> {
  const { items, total } = await reviewRepository.list({
    organizationId: actor.organizationId,
    reviewerUserId: actor.userId,
    status: 'pending',
    page: input.page,
    pageSize: input.pageSize,
  });

  return { items: await annotate(actor, items), total };
}

export async function listMySubmissions(
  actor: Actor,
  input: { page: number; pageSize: number },
): Promise<{ items: ReviewView[]; total: number }> {
  const { items, total } = await reviewRepository.list({
    organizationId: actor.organizationId,
    requestedBy: actor.userId,
    page: input.page,
    pageSize: input.pageSize,
  });

  return { items: await annotate(actor, items), total };
}

/** The approval history of one file. Requires being able to see the file. */
export async function listForFile(actor: Actor, fileId: string): Promise<ReviewView[]> {
  const context = await requireFile(actor, fileId, 'file.view');
  const reviews = await reviewRepository.listForFile(fileId);
  return reviews.map((review) => toView(actor, review, context));
}

export async function pendingCount(actor: Actor): Promise<number> {
  return reviewRepository.countPendingFor(actor.userId);
}

/* --------------------------------------------------------------- internals */

/**
 * A review of a file the viewer can no longer open is dropped from the list rather than
 * rendered — a dashboard row naming a file whose access was revoked is a leak that
 * outlives the revocation.
 */
async function annotate(actor: Actor, reviews: ReviewRecord[]): Promise<ReviewView[]> {
  const views: ReviewView[] = [];
  for (const review of reviews) {
    try {
      const context = await requireFile(actor, review.fileId, 'file.view');
      views.push(toView(actor, review, context));
    } catch {
      continue;
    }
  }
  return views;
}

function toView(actor: Actor, review: ReviewRecord, context: FileContext): ReviewView {
  const isSubmitter = review.requestedBy === actor.userId;
  const isOwner = context.file.ownerId === actor.userId;
  const alreadyDecided = review.decisions.some(
    (decision) => decision.reviewerUserId === actor.userId,
  );

  return {
    ...review,
    approvalsSoFar: review.decisions.filter((decision) => decision.decision === 'approve').length,
    capabilities: {
      canDecide:
        review.status === 'pending' &&
        review.reviewerUserIds.includes(actor.userId) &&
        !isSubmitter &&
        !isOwner &&
        !alreadyDecided &&
        fileCan(actor, 'review.perform', context),
      canCancel:
        review.status === 'pending' && (isSubmitter || fileCan(actor, 'access.manage', context)),
    },
  };
}

/**
 * Validates the requested reviewers.
 *
 * Each must be active, in this organization, able to open the file, and hold the
 * permission to review it. Naming someone who cannot see the file would create a request
 * that can never be satisfied — and a notification announcing a file they may not know
 * exists.
 */
async function resolveReviewers(
  actor: Actor,
  context: FileContext,
  reviewerUserIds: string[],
): Promise<Array<{ id: string; name: string }>> {
  const unique = [...new Set(reviewerUserIds)];
  if (unique.length === 0) throw new ValidationError('Name at least one reviewer');
  if (unique.length > 10) throw new ValidationError('A review can name at most 10 reviewers');

  if (unique.includes(actor.userId)) {
    throw new ValidationError('You cannot name yourself as a reviewer of your own submission');
  }
  if (unique.includes(context.file.ownerId)) {
    throw new ValidationError(
      'The owner of a file cannot review it — the point of a review is a second pair of eyes',
    );
  }

  const users = await userRepository.findByIds(unique);
  if (users.length !== unique.length) throw new NotFoundError('One of those reviewers does not exist');

  const resolved: Array<{ id: string; name: string }> = [];
  for (const user of users) {
    if (user.organizationId !== actor.organizationId) throw new NotFoundError();
    if (user.status !== 'active') {
      throw new ConflictError(`${user.name}'s account is not active, so they cannot be a reviewer`);
    }

    const reviewerActor = await buildReviewerActor(user.id);
    if (!reviewerActor) throw new NotFoundError();

    if (!fileCan(reviewerActor, 'review.perform', context)) {
      throw new ValidationError(
        `${user.name} cannot review this file — they need access to it and the permission to review.`,
      );
    }
    resolved.push({ id: user.id, name: user.name });
  }

  return resolved;
}

async function buildReviewerActor(userId: string): Promise<Actor | null> {
  const roleRepository = await import('@/server/repositories/role.repository');
  const user = await userRepository.findById(userId);
  if (!user) return null;

  const grants = await roleRepository.getActorGrants(userId);

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    organizationId: user.organizationId,
    departmentId: user.departmentId,
    projectIds: user.projectIds,
    isSuperAdmin: user.isSuperAdmin,
    status: user.status,
    grants,
    permissions: new Set(grants.flatMap((grant) => grant.permissions)),
    roleKeys: grants.map((grant) => grant.roleKey),
    highestRank: grants.reduce((max, grant) => Math.max(max, grant.rank), 0),
    sessionId: 'reviewer-check',
    storageQuotaBytes: user.storageQuotaBytes,
    storageUsedBytes: user.storageUsedBytes,
  };
}

export const reviewService = {
  submitForReview,
  decide,
  cancelReview,
  listPendingForMe,
  listMySubmissions,
  listForFile,
  pendingCount,
};
