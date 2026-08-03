/**
 * Folder authorization context.
 *
 * A folder's effective permissions depend on its ancestors, so every folder-scoped
 * check needs the chain loaded first. Doing that in one place means no route can forget
 * it, and the chain is fetched with a single `$in` query rather than one per level.
 *
 * Files reuse this from Phase 4 onward: a file's ancestors are its folder's chain plus
 * the folder itself.
 */
import { NotFoundError } from '@/server/errors/app-error';
import type { Permission } from '@/server/domain/permissions';
import type { Actor, AclEntry, ResourceRef } from '@/server/permissions/actor';
import { assertCan, can, type AuthorizeOptions } from '@/server/permissions/authorize';
import * as folderRepository from '@/server/repositories/folder.repository';
import type { FolderRecord } from '@/server/repositories/folder.repository';

export interface FolderContext {
  folder: FolderRecord;
  /** Ordered root → parent. */
  ancestors: FolderRecord[];
  ancestorAcls: NonNullable<AuthorizeOptions['ancestorAcls']>;
}

export function folderResource(folder: FolderRecord): ResourceRef {
  return {
    type: 'folder',
    id: folder.id,
    organizationId: folder.organizationId,
    departmentId: folder.departmentId,
    projectId: folder.projectId,
    ownerId: folder.ownerId,
    confidentiality: folder.confidentiality,
    folderAncestorIds: folder.pathAncestors,
    acl: folder.permissions,
    inheritPermissions: folder.inheritPermissions,
    status: folder.status,
    deletedAt: folder.deletedAt,
  };
}

/** Builds the ancestor-ACL chain a decision needs, in root → parent order. */
export function toAncestorAcls(ancestors: FolderRecord[]): FolderContext['ancestorAcls'] {
  return ancestors.map((ancestor) => ({
    folderId: ancestor.id,
    acl: ancestor.permissions as AclEntry[],
    inheritPermissions: ancestor.inheritPermissions,
  }));
}

export async function loadFolderContext(
  folderId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<FolderContext | null> {
  const folder = await folderRepository.findById(folderId, options);
  if (!folder) return null;

  const ancestorDocs = await folderRepository.findByIds(folder.pathAncestors);
  // findByIds does not preserve order; pathAncestors is the authority on it.
  const byId = new Map(ancestorDocs.map((doc) => [doc.id, doc]));
  const ancestors = folder.pathAncestors
    .map((id) => byId.get(id))
    .filter((doc): doc is FolderRecord => doc !== undefined);

  return { folder, ancestors, ancestorAcls: toAncestorAcls(ancestors) };
}

/**
 * Loads a folder and asserts the permission, or throws.
 *
 * A folder the actor cannot see is reported as 404 by `assertCan` — a 403 would confirm
 * the id exists (docs/phase-0/08-security-threat-model.md).
 */
export async function requireFolder(
  actor: Actor,
  folderId: string,
  permission: Permission,
  options: { includeDeleted?: boolean } = {},
): Promise<FolderContext> {
  const context = await loadFolderContext(folderId, options);
  if (!context) throw new NotFoundError();

  assertCan(actor, permission, folderResource(context.folder), {
    ancestorAcls: context.ancestorAcls,
  });
  return context;
}

/** Non-throwing variant, for annotating list rows with the actions the viewer has. */
export function folderCan(
  actor: Actor,
  permission: Permission,
  context: FolderContext,
): boolean {
  return can(actor, permission, folderResource(context.folder), {
    ancestorAcls: context.ancestorAcls,
  });
}

/**
 * Capability flags for one folder, used by the UI to grey out actions.
 * The API re-checks every one of these server-side; this list is a rendering hint.
 */
export function folderCapabilities(actor: Actor, context: FolderContext) {
  const check = (permission: Permission) => folderCan(actor, permission, context);
  const mutable = !context.folder.isSystem;
  return {
    canCreateFolder: check('folder.create'),
    canUpload: check('file.upload'),
    canRename: mutable && check('resource.rename'),
    canMove: mutable && check('resource.move'),
    canCopy: check('resource.copy'),
    canDelete: mutable && check('resource.delete'),
    canArchive: mutable && check('resource.archive'),
    canRestore: check('resource.restore'),
    canShare: check('share.internal'),
    canManageAccess: check('access.manage'),
    canDownload: check('file.download'),
  };
}
