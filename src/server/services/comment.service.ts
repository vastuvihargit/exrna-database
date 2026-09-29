/**
 * Comments and @mentions.
 *
 * Two rules shape everything here.
 *
 * **A comment cannot change the file.** Comments live in their own collection with no
 * write path into `File` or `FileVersion`, so commenting on an approved file is allowed
 * — it is discussion, not modification, and forbidding it would push that discussion
 * into email where it stops being part of the record.
 *
 * **A mention is not a grant.** Naming someone with `@` notifies them; it does not give
 * them access. A mention of someone who cannot open the file is dropped silently rather
 * than sending them a notification naming a file they may not know exists — the
 * notification itself would be the disclosure.
 */
import { ForbiddenError, NotFoundError, ValidationError } from '@/server/errors/app-error';
import type { Actor } from '@/server/permissions/actor';
import { can } from '@/server/permissions/authorize';
import { auditService } from '@/server/audit/audit.service';
import * as activityRepository from '@/server/repositories/activity.repository';
import * as commentRepository from '@/server/repositories/comment.repository';
import type { CommentRecord } from '@/server/repositories/comment.repository';
import * as notificationRepository from '@/server/repositories/notification.repository';
import * as userRepository from '@/server/repositories/user.repository';
import * as versionRepository from '@/server/repositories/file-version.repository';
import type { RequestMeta } from '@/server/http/request-meta';
import { fileCan, fileResource, loadFileContext, requireFile, type FileContext } from './file-access';
import { detach } from '@/server/runtime/detach';
import { dispatchNotifications } from '@/server/queues/notification-dispatch';

export interface CommentView extends CommentRecord {
  replies: CommentRecord[];
  capabilities: { canEdit: boolean; canDelete: boolean; canResolve: boolean };
}

/** Matches `@name.surname@company.com` and `@Firstname Lastname`, longest form first. */
const MENTION_PATTERN = /@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|@([A-Za-z][A-Za-z'-]+(?: [A-Z][A-Za-z'-]+)?)/g;

export async function listComments(
  actor: Actor,
  fileId: string,
  options: { includeResolved?: boolean } = {},
): Promise<CommentView[]> {
  // Reading the discussion needs only view access — a reviewer who may look at a file
  // must be able to read what has already been said about it.
  const context = await requireFile(actor, fileId, 'file.view');

  const all = await commentRepository.listForFile(fileId, options);

  const roots = all.filter((comment) => comment.parentCommentId === null);
  const repliesByParent = new Map<string, CommentRecord[]>();
  for (const comment of all) {
    if (!comment.parentCommentId) continue;
    const bucket = repliesByParent.get(comment.parentCommentId) ?? [];
    bucket.push(comment);
    repliesByParent.set(comment.parentCommentId, bucket);
  }

  return roots.map((comment) => ({
    ...comment,
    replies: repliesByParent.get(comment.id) ?? [],
    capabilities: capabilitiesFor(actor, context, comment),
  }));
}

export interface CreateCommentInput {
  body: string;
  parentCommentId?: string;
  /** Pins the comment to a specific version. Defaults to whatever is current. */
  versionId?: string;
}

export async function addComment(
  actor: Actor,
  fileId: string,
  input: CreateCommentInput,
  meta: RequestMeta,
): Promise<CommentView> {
  const context = await requireFile(actor, fileId, 'comment.create');

  const body = input.body.trim();
  if (!body) throw new ValidationError('A comment cannot be empty');

  let parent: CommentRecord | null = null;
  if (input.parentCommentId) {
    parent = await commentRepository.findById(input.parentCommentId);
    if (!parent || parent.fileId !== fileId) throw new NotFoundError('That comment does not exist');
    if (parent.parentCommentId) {
      // One level only. Replying to a reply joins the same thread rather than starting
      // a nested one nobody can follow in a side panel.
      parent = await commentRepository.findById(parent.parentCommentId);
      if (!parent) throw new NotFoundError('That comment does not exist');
    }
  }

  // Pinning to a version keeps "which version was this objection about?" answerable
  // after three more uploads.
  const version = input.versionId
    ? await versionRepository.findById(input.versionId)
    : context.file.currentVersionId
      ? await versionRepository.findById(context.file.currentVersionId)
      : null;

  if (input.versionId && (!version || version.fileId !== fileId)) {
    throw new NotFoundError('That version does not belong to this file');
  }

  const mentioned = await resolveMentions(actor, context, body);

  const comment = await commentRepository.create({
    organizationId: actor.organizationId,
    fileId,
    versionId: version?.id ?? null,
    versionNumber: version?.versionNumber ?? null,
    parentCommentId: parent?.id ?? null,
    authorUserId: actor.userId,
    authorName: actor.name,
    body,
    mentionedUserIds: mentioned.map((user) => user.id),
  });

  await auditService.recordForActor(actor, meta, {
    action: 'file.comment',
    entityType: 'file',
    entityId: fileId,
    entityLabel: context.file.displayName,
    newValue: {
      commentId: comment.id,
      versionNumber: comment.versionNumber,
      isReply: Boolean(parent),
      mentionedCount: mentioned.length,
    },
  });

  detach(
    activityRepository
      .append({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorName: actor.name,
        action: 'file.comment',
        entityType: 'file',
        entityId: fileId,
        entityLabel: context.file.displayName,
        detail: parent ? 'replied to a comment' : 'commented',
        contextFolderIds: context.file.folderPathAncestors,
        departmentId: context.file.departmentId,
        projectId: context.file.projectId,
      }),
    'activity.append',
  );

  detach(notify(actor, context, comment, parent, mentioned), 'notifications.comment');

  return { ...comment, replies: [], capabilities: capabilitiesFor(actor, context, comment) };
}

export async function editComment(
  actor: Actor,
  fileId: string,
  commentId: string,
  body: string,
  meta: RequestMeta,
): Promise<CommentRecord> {
  const context = await requireFile(actor, fileId, 'file.view');
  const comment = await requireComment(fileId, commentId);

  // Only the author edits their own words. An editor rewriting someone else's comment
  // would make the discussion record untrustworthy, which is the one thing it must not be.
  if (comment.authorUserId !== actor.userId) {
    throw new ForbiddenError('You can only edit your own comments');
  }

  const trimmed = body.trim();
  if (!trimmed) throw new ValidationError('A comment cannot be empty');

  const updated = await commentRepository.updateBody(commentId, trimmed);
  if (!updated) throw new NotFoundError();

  await auditService.recordForActor(actor, meta, {
    action: 'file.comment',
    entityType: 'comment',
    entityId: commentId,
    entityLabel: context.file.displayName,
    previousValue: { body: comment.body },
    newValue: { body: trimmed },
  });

  return updated;
}

export async function deleteComment(
  actor: Actor,
  fileId: string,
  commentId: string,
  meta: RequestMeta,
): Promise<void> {
  const context = await requireFile(actor, fileId, 'file.view');
  const comment = await requireComment(fileId, commentId);

  // The author, or someone who administers access to the file — the latter so an
  // inappropriate comment on a shared file can be removed by someone.
  const isAuthor = comment.authorUserId === actor.userId;
  if (!isAuthor && !fileCan(actor, 'access.manage', context)) {
    throw new ForbiddenError('You can only delete your own comments');
  }

  await commentRepository.softDelete(commentId, actor.userId);

  await auditService.recordForActor(actor, meta, {
    action: 'file.comment',
    entityType: 'comment',
    entityId: commentId,
    entityLabel: context.file.displayName,
    previousValue: { body: comment.body, authorUserId: comment.authorUserId },
    newValue: null,
    reason: isAuthor ? 'deleted by author' : 'deleted by access manager',
    severity: 'notice',
  });
}

export async function setResolved(
  actor: Actor,
  fileId: string,
  commentId: string,
  resolved: boolean,
  meta: RequestMeta,
): Promise<CommentRecord> {
  const context = await requireFile(actor, fileId, 'comment.create');
  const comment = await requireComment(fileId, commentId);

  if (comment.parentCommentId) {
    throw new ValidationError('Resolve the thread, not an individual reply');
  }

  const updated = await commentRepository.setResolved(commentId, resolved, actor.userId);
  if (!updated) throw new NotFoundError();

  await auditService.recordForActor(actor, meta, {
    action: 'file.comment',
    entityType: 'comment',
    entityId: commentId,
    entityLabel: context.file.displayName,
    newValue: { resolved },
  });

  return updated;
}

/* ----------------------------------------------------------------- internals */

async function requireComment(fileId: string, commentId: string): Promise<CommentRecord> {
  const comment = await commentRepository.findById(commentId);
  if (!comment || comment.fileId !== fileId) throw new NotFoundError('That comment does not exist');
  return comment;
}

function capabilitiesFor(actor: Actor, context: FileContext, comment: CommentRecord) {
  const isAuthor = comment.authorUserId === actor.userId;
  return {
    canEdit: isAuthor,
    canDelete: isAuthor || fileCan(actor, 'access.manage', context),
    canResolve: fileCan(actor, 'comment.create', context),
  };
}

/**
 * Turns `@…` fragments into user ids — but only for people who can actually open the file.
 *
 * A mention of someone without access is dropped rather than rejected: telling the author
 * "that person cannot see this file" is itself a small disclosure about who has access to
 * what, and the author can see for themselves that no notification arrived.
 */
async function resolveMentions(
  actor: Actor,
  context: FileContext,
  body: string,
): Promise<Array<{ id: string; name: string }>> {
  const emails = new Set<string>();
  const names = new Set<string>();

  for (const match of body.matchAll(MENTION_PATTERN)) {
    if (match[1]) emails.add(match[1].toLowerCase());
    else if (match[2]) names.add(match[2]);
  }
  if (emails.size === 0 && names.size === 0) return [];

  const candidates = await userRepository.findForMentions({
    organizationId: actor.organizationId,
    emails: [...emails],
    names: [...names],
    limit: 20,
  });

  const resolved: Array<{ id: string; name: string }> = [];
  for (const candidate of candidates) {
    if (candidate.id === actor.userId) continue;
    if (candidate.status !== 'active') continue;

    // The mentioned person is checked against the same authorizer the file's own routes
    // use — a mention must never become a side channel that reveals a file's existence.
    const mentionedActor = await buildMinimalActor(candidate.id);
    if (!mentionedActor) continue;
    if (
      !can(mentionedActor, 'file.view', fileResource(context.file), {
        ancestorAcls: context.ancestorAcls,
      })
    ) {
      continue;
    }
    resolved.push({ id: candidate.id, name: candidate.name });
  }

  return resolved;
}

/**
 * The permission-relevant slice of another user, assembled the same way a login would.
 *
 * Hand-building this would risk granting the mentioned user something the real login
 * path would not, so it goes through the same repositories.
 */
async function buildMinimalActor(userId: string): Promise<Actor | null> {
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
    sessionId: 'mention-check',
    storageQuotaBytes: user.storageQuotaBytes,
    storageUsedBytes: user.storageUsedBytes,
  };
}

/**
 * Notifies the people a comment concerns.
 *
 * Mentions first, then the thread's other participants — deduplicated, and never the
 * author of the comment itself. Participants are only notified if they still have access,
 * which is re-checked here rather than assumed from the fact that they once commented.
 */
async function notify(
  actor: Actor,
  context: FileContext,
  comment: CommentRecord,
  parent: CommentRecord | null,
  mentioned: Array<{ id: string; name: string }>,
): Promise<void> {
  const notified = new Set<string>([actor.userId]);
  const queue: notificationRepository.CreateNotificationInput[] = [];

  const base = {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorName: actor.name,
    entityType: 'file',
    entityId: context.file.id,
    entityLabel: context.file.displayName,
  };

  for (const person of mentioned) {
    if (notified.has(person.id)) continue;
    notified.add(person.id);
    queue.push({
      ...base,
      userId: person.id,
      type: 'comment.mention',
      message: `${actor.name} mentioned you on "${context.file.displayName}"`,
    });
  }

  if (parent && !notified.has(parent.authorUserId)) {
    const stillHasAccess = await hasViewAccess(parent.authorUserId, context);
    if (stillHasAccess) {
      notified.add(parent.authorUserId);
      queue.push({
        ...base,
        userId: parent.authorUserId,
        type: 'comment.reply',
        message: `${actor.name} replied to your comment on "${context.file.displayName}"`,
      });
    }
  }

  // The file's owner hears about discussion on their own work, unless they started it.
  if (!notified.has(context.file.ownerId)) {
    notified.add(context.file.ownerId);
    queue.push({
      ...base,
      userId: context.file.ownerId,
      type: 'comment.added',
      message: `${actor.name} commented on "${context.file.displayName}"`,
    });
  }

  // Keyed on the comment, so a redelivered queue message cannot notify anybody twice.
  await dispatchNotifications(queue, `comment:${comment.id}`);
}

async function hasViewAccess(userId: string, context: FileContext): Promise<boolean> {
  const other = await buildMinimalActor(userId);
  if (!other || other.status !== 'active') return false;
  return can(other, 'file.view', fileResource(context.file), {
    ancestorAcls: context.ancestorAcls,
  });
}

/** Used by the purge job so comments do not outlive the file they discuss. */
export async function purgeForFiles(fileIds: string[]): Promise<number> {
  return commentRepository.purgeForFiles(fileIds);
}

export const commentService = {
  listComments,
  addComment,
  editComment,
  deleteComment,
  setResolved,
  purgeForFiles,
};

/** Exported for the file-details panel's unread badge. */
export async function commentCount(actor: Actor, fileId: string): Promise<number> {
  const context = await loadFileContext(actor, fileId);
  if (!context) return 0;
  if (!can(actor, 'file.view', fileResource(context.file), { ancestorAcls: context.ancestorAcls })) {
    return 0;
  }
  return commentRepository.countForFile(fileId);
}
