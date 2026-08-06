/**
 * Internal sharing.
 *
 * The whole of this module is one idea: an ACL entry is a *delegation*, and you cannot
 * delegate what you do not hold. Every guard below follows from that.
 *
 *   • You may not grant an access level whose permission bundle contains something you
 *     cannot do on this resource yourself. Without that check, a `commenter` could grant
 *     someone `manager` and then be granted it back — privilege escalation in two
 *     requests, with both of them audited as ordinary shares.
 *
 *   • Denies and inheritance changes require `access.manage`, not `share.internal`.
 *     Sharing adds reach; denying and breaking inheritance *remove* it from people who
 *     had it, which is an administrative act with a different blast radius.
 *
 *   • Revocation is immediate because there is nothing to invalidate: the Actor is
 *     rebuilt per request and ACLs are read from the document on every decision. There
 *     is deliberately no permission cache anywhere in this codebase.
 *
 * There are no public links and no "anyone with the link" — not unimplemented, but
 * absent by construction: an ACL entry must name a principal that exists in this
 * organization, and there is no principal type that means "everyone".
 */
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/server/errors/app-error';
import { MAX_ACL_ENTRIES } from '@/server/db/acl-schema';
import {
  permissionsForAccessLevel,
  type AccessLevel,
  type PrincipalType,
} from '@/server/domain/permissions';
import type { Actor, AclEntry } from '@/server/permissions/actor';
import { auditService } from '@/server/audit/audit.service';
import * as activityRepository from '@/server/repositories/activity.repository';
import * as departmentRepository from '@/server/repositories/department.repository';
import * as fileRepository from '@/server/repositories/file.repository';
import * as folderRepository from '@/server/repositories/folder.repository';
import * as projectRepository from '@/server/repositories/project.repository';
import * as roleRepository from '@/server/repositories/role.repository';
import * as userRepository from '@/server/repositories/user.repository';
import * as notificationRepository from '@/server/repositories/notification.repository';
import type { RequestMeta } from '@/server/http/request-meta';
import { fileCan, requireFile, type FileContext } from './file-access';
import { folderCan, requireFolder, type FolderContext } from './folder-access';

export type ShareTargetType = 'file' | 'folder';

export interface ShareGrantInput {
  principalType: PrincipalType;
  principalId: string;
  accessLevel: AccessLevel;
  deny?: boolean;
  expiresAt?: Date | null;
}

/** One ACL entry, resolved to a human-readable principal for display. */
export interface ShareEntryView {
  principalType: PrincipalType;
  principalId: string;
  principalName: string;
  /** Present for users, so the UI can disambiguate two people with the same name. */
  principalEmail: string | null;
  accessLevel: AccessLevel;
  deny: boolean;
  expiresAt: Date | null;
  /** True when this entry comes from an ancestor folder rather than the resource itself. */
  inherited: boolean;
  inheritedFromFolderId: string | null;
  inheritedFromFolderName: string | null;
}

export interface ShareStateView {
  targetType: ShareTargetType;
  targetId: string;
  targetName: string;
  inheritPermissions: boolean;
  ownerId: string;
  confidentiality: string;
  entries: ShareEntryView[];
  /** What the *viewer* may do to this share list. */
  capabilities: { canShare: boolean; canManageAccess: boolean };
}

/* ------------------------------------------------------------------- reads */

export async function getShareState(
  actor: Actor,
  targetType: ShareTargetType,
  targetId: string,
): Promise<ShareStateView> {
  // Seeing who else has access is itself a disclosure — it names colleagues and implies
  // what they work on — so it needs `share.internal`, not merely view.
  const context = await loadTarget(actor, targetType, targetId, 'share.internal');

  const direct = aclOf(context);
  const inherited = context.inheritPermissions ? context.ancestorEntries : [];

  const entries = await resolvePrincipals([
    ...direct.map((entry) => ({ entry, inheritedFrom: null as null | { id: string; name: string } })),
    ...inherited,
  ]);

  return {
    targetType,
    targetId,
    targetName: context.name,
    inheritPermissions: context.inheritPermissions,
    ownerId: context.ownerId,
    confidentiality: context.confidentiality,
    entries,
    capabilities: {
      canShare: context.can('share.internal'),
      canManageAccess: context.can('access.manage'),
    },
  };
}

/* ----------------------------------------------------------------- mutations */

export async function share(
  actor: Actor,
  targetType: ShareTargetType,
  targetId: string,
  input: ShareGrantInput,
  meta: RequestMeta,
): Promise<ShareStateView> {
  // A deny is a removal of access, not a grant of it.
  const permission = input.deny ? 'access.manage' : 'share.internal';
  const context = await loadTarget(actor, targetType, targetId, permission);

  assertMayDelegate(actor, context, input.accessLevel);

  const principal = await resolvePrincipal(actor, input.principalType, input.principalId);

  if (input.principalType === 'user' && input.principalId === context.ownerId) {
    throw new ConflictError(
      'That person owns this item — they already have access, and an entry here could only take it away',
    );
  }

  const existing = aclOf(context);
  if (existing.length >= MAX_ACL_ENTRIES && !existing.some((entry) => matches(entry, input))) {
    throw new ConflictError(
      `An item can carry at most ${MAX_ACL_ENTRIES} share entries. Share with a department, project or role instead of listing people individually.`,
      'CONFLICT',
    );
  }

  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw new ValidationError('An expiry date has to be in the future');
  }

  // Replace-then-append rather than a positional update: an ACL is a set keyed by
  // (principalType, principalId), so re-sharing at a different level must change the
  // existing entry, not stack a second one that the resolver would have to reconcile.
  const next: AclEntry[] = [
    ...existing.filter((entry) => !matches(entry, input)),
    {
      principalType: input.principalType,
      principalId: input.principalId,
      accessLevel: input.accessLevel,
      deny: input.deny ?? false,
      expiresAt: input.expiresAt ?? null,
    },
  ];

  await writeAcl(targetType, targetId, next, actor.userId);

  await auditService.recordForActor(actor, meta, {
    action: 'file.share',
    entityType: targetType,
    entityId: targetId,
    entityLabel: context.name,
    previousValue: { entries: existing },
    newValue: {
      principalType: input.principalType,
      principalId: input.principalId,
      principalName: principal.name,
      accessLevel: input.accessLevel,
      deny: input.deny ?? false,
      expiresAt: input.expiresAt ?? null,
    },
    severity: input.deny ? 'warning' : 'notice',
  });

  void activityRepository
    .append({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorName: actor.name,
      action: 'file.share',
      entityType: targetType,
      entityId: targetId,
      entityLabel: context.name,
      detail: `${input.deny ? 'blocked' : 'shared with'} ${principal.name} (${input.accessLevel})`,
      contextFolderIds: context.contextFolderIds,
      departmentId: context.departmentId,
      projectId: context.projectId,
    })
    .catch(() => undefined);

  // Notify the people who just gained access — but never on a deny, which would tell
  // someone they have been specifically excluded from something they may not know exists.
  if (!input.deny) {
    void notifyRecipients(actor, context, targetType, targetId, input).catch(() => undefined);
  }

  return getShareState(actor, targetType, targetId);
}

export async function revokeShare(
  actor: Actor,
  targetType: ShareTargetType,
  targetId: string,
  principalType: PrincipalType,
  principalId: string,
  meta: RequestMeta,
): Promise<ShareStateView> {
  const context = await loadTarget(actor, targetType, targetId, 'share.internal');

  const existing = aclOf(context);
  const removed = existing.find(
    (entry) => entry.principalType === principalType && entry.principalId === principalId,
  );
  if (!removed) throw new NotFoundError('That share does not exist on this item');

  // Removing a *deny* restores access, so it is governed by the permission that granted
  // the deny in the first place rather than by ordinary sharing.
  if (removed.deny && !context.can('access.manage')) {
    throw new ForbiddenError('Removing an access block requires permission to manage access');
  }

  const next = existing.filter(
    (entry) => !(entry.principalType === principalType && entry.principalId === principalId),
  );

  await writeAcl(targetType, targetId, next, actor.userId);

  await auditService.recordForActor(actor, meta, {
    action: 'file.permission_change',
    entityType: targetType,
    entityId: targetId,
    entityLabel: context.name,
    previousValue: removed,
    newValue: null,
    reason: 'share revoked',
    severity: 'warning',
  });

  return getShareState(actor, targetType, targetId);
}

/**
 * Breaks or restores inheritance from the folder chain.
 *
 * Breaking inheritance is how a sensitive file lives inside a widely shared folder. It
 * is an `access.manage` action because it silently removes access from everyone who had
 * it only through the parent — the people affected are not named anywhere in the
 * request, which is exactly why it must be audited with the entries that were in force.
 */
export async function setInheritance(
  actor: Actor,
  targetType: ShareTargetType,
  targetId: string,
  inherit: boolean,
  meta: RequestMeta,
): Promise<ShareStateView> {
  const context = await loadTarget(actor, targetType, targetId, 'access.manage');

  if (context.inheritPermissions === inherit) {
    return getShareState(actor, targetType, targetId);
  }

  // Breaking inheritance with an empty own-ACL would leave the item reachable only by
  // its owner and by role scope — usually a mistake, and an unrecoverable one for a
  // colleague who was mid-review. Copying the inherited entries down keeps today's
  // access exactly as it is and lets the caller prune from there.
  let ownAcl = aclOf(context);
  if (!inherit && ownAcl.length === 0 && context.ancestorEntries.length > 0) {
    ownAcl = context.ancestorEntries.map(({ entry }) => ({ ...entry }));
  }

  await writeAcl(targetType, targetId, ownAcl, actor.userId, inherit);

  await auditService.recordForActor(actor, meta, {
    action: 'file.permission_change',
    entityType: targetType,
    entityId: targetId,
    entityLabel: context.name,
    previousValue: {
      inheritPermissions: context.inheritPermissions,
      effectiveEntries: context.ancestorEntries.map(({ entry }) => entry),
    },
    newValue: { inheritPermissions: inherit, entries: ownAcl },
    reason: inherit ? 'inheritance restored' : 'inheritance broken',
    severity: 'warning',
  });

  return getShareState(actor, targetType, targetId);
}

/* -------------------------------------------------------------- shared with me */

export interface SharedWithMeResult {
  files: Awaited<ReturnType<typeof fileRepository.listSharedWith>>['items'];
  folders: Awaited<ReturnType<typeof folderRepository.listSharedWith>>['items'];
  totals: { files: number; folders: number };
}

/**
 * Everything reachable through an explicit grant rather than through role scope.
 *
 * Deliberately *not* "everything you can see": a department head can see their whole
 * department, and listing all of it here would make the page useless. This answers
 * "what did someone hand to me personally?"
 */
export async function listSharedWithMe(
  actor: Actor,
  input: { page: number; pageSize: number },
): Promise<SharedWithMeResult> {
  const principalIds = [
    actor.userId,
    ...(actor.departmentId ? [actor.departmentId] : []),
    ...actor.projectIds,
    ...actor.grants.map((grant) => grant.roleId),
  ];

  const [files, folders] = await Promise.all([
    fileRepository.listSharedWith({
      organizationId: actor.organizationId,
      principalIds,
      excludeOwnerId: actor.userId,
      page: input.page,
      pageSize: input.pageSize,
    }),
    folderRepository.listSharedWith({
      actor,
      principalIds,
      page: input.page,
      pageSize: input.pageSize,
    }),
  ]);

  return {
    files: files.items,
    folders: folders.items,
    totals: { files: files.total, folders: folders.total },
  };
}

/* ----------------------------------------------------------------- internals */

/**
 * Uniform view over the two shareable resource types.
 *
 * Files and folders differ in almost every field name, but every sharing rule applies to
 * both identically — so they are normalized once here rather than every guard being
 * written twice and drifting.
 */
interface ShareTargetContext {
  name: string;
  ownerId: string;
  confidentiality: string;
  inheritPermissions: boolean;
  departmentId: string | null;
  projectId: string | null;
  contextFolderIds: string[];
  acl: AclEntry[];
  ancestorEntries: Array<{ entry: AclEntry; inheritedFrom: { id: string; name: string } }>;
  can: (permission: Parameters<typeof fileCan>[1]) => boolean;
}

async function loadTarget(
  actor: Actor,
  targetType: ShareTargetType,
  targetId: string,
  permission: Parameters<typeof fileCan>[1],
): Promise<ShareTargetContext> {
  if (targetType === 'file') {
    const context = await requireFile(actor, targetId, permission);
    return fromFile(actor, context);
  }
  const context = await requireFolder(actor, targetId, permission);
  return fromFolder(actor, context);
}

function fromFile(actor: Actor, context: FileContext): ShareTargetContext {
  return {
    name: context.file.displayName,
    ownerId: context.file.ownerId,
    confidentiality: context.file.confidentiality,
    inheritPermissions: context.file.inheritPermissions,
    departmentId: context.file.departmentId,
    projectId: context.file.projectId,
    contextFolderIds: context.file.folderPathAncestors,
    acl: context.file.permissions,
    ancestorEntries: collectAncestorEntries(context.folderChain),
    can: (permission) => fileCan(actor, permission, context),
  };
}

function fromFolder(actor: Actor, context: FolderContext): ShareTargetContext {
  return {
    name: context.folder.name,
    ownerId: context.folder.ownerId,
    confidentiality: context.folder.confidentiality,
    inheritPermissions: context.folder.inheritPermissions,
    departmentId: context.folder.departmentId,
    projectId: context.folder.projectId,
    contextFolderIds: context.folder.pathAncestors,
    acl: context.folder.permissions,
    ancestorEntries: collectAncestorEntries(context.ancestors),
    can: (permission) => folderCan(actor, permission, context),
  };
}

/**
 * Inherited entries, walking leaf → root and stopping at the first ancestor that has
 * broken inheritance — the same traversal `canAccess` performs, so what the share dialog
 * displays is what the authorizer will actually decide.
 */
function collectAncestorEntries(
  chain: Array<{ id: string; name: string; permissions: AclEntry[]; inheritPermissions: boolean }>,
): Array<{ entry: AclEntry; inheritedFrom: { id: string; name: string } }> {
  const collected: Array<{ entry: AclEntry; inheritedFrom: { id: string; name: string } }> = [];

  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const ancestor = chain[i]!;
    for (const entry of ancestor.permissions) {
      collected.push({ entry, inheritedFrom: { id: ancestor.id, name: ancestor.name } });
    }
    if (!ancestor.inheritPermissions) break;
  }

  return collected;
}

function aclOf(context: ShareTargetContext): AclEntry[] {
  return context.acl.map((entry) => ({ ...entry }));
}

function matches(entry: AclEntry, input: ShareGrantInput): boolean {
  return entry.principalType === input.principalType && entry.principalId === input.principalId;
}

/**
 * The delegation guard.
 *
 * An access level is a bundle of permissions; granting it must not hand over anything
 * the granter cannot do on this very resource. Checked per-permission rather than by
 * comparing level names, because the levels are not a single ordered ladder —
 * `reviewer` and `editor` each hold things the other does not.
 */
function assertMayDelegate(
  actor: Actor,
  context: ShareTargetContext,
  level: AccessLevel,
): void {
  if (actor.isSuperAdmin) return;

  const conferred = permissionsForAccessLevel(level);
  const missing = conferred.filter((permission) => !context.can(permission));

  if (missing.length > 0) {
    throw new ForbiddenError(
      `You cannot grant "${level}" access here — it would give away permissions you do not hold on this item yourself.`,
    );
  }
}

/** Confirms the principal exists in this organization and gives it a display name. */
async function resolvePrincipal(
  actor: Actor,
  principalType: PrincipalType,
  principalId: string,
): Promise<{ name: string; email: string | null }> {
  switch (principalType) {
    case 'user': {
      const user = await userRepository.findById(principalId);
      // Sharing with a deactivated account would leave a grant that silently reactivates
      // with the person — the audit trail would show the share, not the reactivation.
      if (!user || user.organizationId !== actor.organizationId) {
        throw new NotFoundError('That person is not in this organization');
      }
      if (user.status !== 'active') {
        throw new ConflictError('That account is not active, so it cannot be given access');
      }
      return { name: user.name, email: user.email };
    }
    case 'department': {
      const department = await departmentRepository.findById(principalId);
      if (!department || department.organizationId !== actor.organizationId) {
        throw new NotFoundError('That department does not exist');
      }
      return { name: department.name, email: null };
    }
    case 'project': {
      const project = await projectRepository.findById(principalId);
      if (!project || project.organizationId !== actor.organizationId) {
        throw new NotFoundError('That project does not exist');
      }
      return { name: project.name, email: null };
    }
    case 'role': {
      const role = await roleRepository.findRoleById(principalId);
      if (!role || role.organizationId !== actor.organizationId) {
        throw new NotFoundError('That role does not exist');
      }
      return { name: role.name, email: null };
    }
  }
}

async function resolvePrincipals(
  entries: Array<{ entry: AclEntry; inheritedFrom: { id: string; name: string } | null }>,
): Promise<ShareEntryView[]> {
  const userIds = entries.filter((row) => row.entry.principalType === 'user').map((row) => row.entry.principalId);
  const departmentIds = entries.filter((row) => row.entry.principalType === 'department').map((row) => row.entry.principalId);
  const projectIds = entries.filter((row) => row.entry.principalType === 'project').map((row) => row.entry.principalId);
  const roleIds = entries.filter((row) => row.entry.principalType === 'role').map((row) => row.entry.principalId);

  const [users, departments, projects, roles] = await Promise.all([
    userIds.length ? userRepository.findByIds(userIds) : Promise.resolve([]),
    departmentIds.length ? departmentRepository.findByIds(departmentIds) : Promise.resolve([]),
    projectIds.length ? projectRepository.findByIds(projectIds) : Promise.resolve([]),
    roleIds.length ? roleRepository.findRolesByIds(roleIds) : Promise.resolve([]),
  ]);

  const userById = new Map(users.map((user) => [user.id, user]));
  const departmentById = new Map(departments.map((department) => [department.id, department]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const roleById = new Map(roles.map((role) => [role.id, role]));

  return entries.map(({ entry, inheritedFrom }) => {
    const user = entry.principalType === 'user' ? userById.get(entry.principalId) : undefined;
    const name =
      user?.name ??
      departmentById.get(entry.principalId)?.name ??
      projectById.get(entry.principalId)?.name ??
      roleById.get(entry.principalId)?.name ??
      // A principal that no longer resolves is shown rather than hidden: a stale grant
      // that is invisible in the dialog is a grant nobody will ever think to remove.
      'Removed principal';

    return {
      principalType: entry.principalType,
      principalId: entry.principalId,
      principalName: name,
      principalEmail: user?.email ?? null,
      accessLevel: entry.accessLevel as AccessLevel,
      deny: Boolean(entry.deny),
      expiresAt: entry.expiresAt ?? null,
      inherited: inheritedFrom !== null,
      inheritedFromFolderId: inheritedFrom?.id ?? null,
      inheritedFromFolderName: inheritedFrom?.name ?? null,
    };
  });
}

async function writeAcl(
  targetType: ShareTargetType,
  targetId: string,
  entries: AclEntry[],
  actorUserId: string,
  inheritPermissions?: boolean,
): Promise<void> {
  const permissions = entries.map((entry) => ({
    principalType: entry.principalType,
    principalId: entry.principalId,
    accessLevel: entry.accessLevel,
    deny: Boolean(entry.deny),
    expiresAt: entry.expiresAt ?? null,
    grantedBy: actorUserId,
  }));

  // Two shapes for one change: the file repository still speaks MongoDB update documents,
  // the folder repository now speaks a database-neutral patch.
  const updated =
    targetType === 'file'
      ? await fileRepository.updateById(targetId, {
          $set: {
            permissions,
            updatedBy: actorUserId,
            ...(inheritPermissions !== undefined ? { inheritPermissions } : {}),
          },
        })
      : await folderRepository.updateById(targetId, {
          permissions,
          updatedBy: actorUserId,
          ...(inheritPermissions !== undefined ? { inheritPermissions } : {}),
        });

  if (!updated) throw new NotFoundError();
}

/**
 * Tells the people who just gained access.
 *
 * Only direct user grants produce a notification. Sharing with a 400-person department
 * must not fan out to 400 rows — the item appears in their "Shared with me" instead,
 * which is a pull rather than a push.
 */
async function notifyRecipients(
  actor: Actor,
  context: ShareTargetContext,
  targetType: ShareTargetType,
  targetId: string,
  input: ShareGrantInput,
): Promise<void> {
  if (input.principalType !== 'user') return;
  if (input.principalId === actor.userId) return;

  await notificationRepository.create({
    organizationId: actor.organizationId,
    userId: input.principalId,
    type: 'share.received',
    actorUserId: actor.userId,
    actorName: actor.name,
    entityType: targetType,
    entityId: targetId,
    entityLabel: context.name,
    message: `${actor.name} shared "${context.name}" with you (${input.accessLevel})`,
  });
}

export const sharingService = {
  getShareState,
  share,
  revokeShare,
  setInheritance,
  listSharedWithMe,
};
