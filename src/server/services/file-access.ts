/**
 * File authorization context.
 *
 * A file's effective permissions are its own ACL layered on top of its folder chain, so
 * a decision needs both. This mirrors `folder-access.ts` and exists for the same
 * reason: one place that cannot be forgotten, one query for the whole chain.
 */
import { NotFoundError } from '@/server/errors/app-error';
import type { Permission } from '@/server/domain/permissions';
import type { Actor, AclEntry, ResourceRef } from '@/server/permissions/actor';
import { assertCan, can, type AuthorizeOptions } from '@/server/permissions/authorize';
import * as fileRepository from '@/server/repositories/file.repository';
import type { FileRecord } from '@/server/repositories/file.repository';
import * as folderRepository from '@/server/repositories/folder.repository';
import type { FolderRecord } from '@/server/repositories/folder.repository';

export interface FileContext {
  file: FileRecord;
  /** Ordered root → containing folder. */
  folderChain: FolderRecord[];
  ancestorAcls: NonNullable<AuthorizeOptions['ancestorAcls']>;
}

export function fileResource(file: FileRecord): ResourceRef {
  return {
    type: 'file',
    id: file.id,
    organizationId: file.organizationId,
    departmentId: file.departmentId,
    projectId: file.projectId,
    ownerId: file.ownerId,
    confidentiality: file.confidentiality,
    folderAncestorIds: [...file.folderPathAncestors],
    acl: file.permissions,
    inheritPermissions: file.inheritPermissions,
    status: file.status,
    deletedAt: file.deletedAt,
  };
}

export async function loadFileContext(
  fileId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<FileContext | null> {
  const file = await fileRepository.findById(fileId, options);
  if (!file) return null;

  // folderPathAncestors already ends with the containing folder, so this one query
  // covers the whole chain.
  const chainIds = file.folderPathAncestors;
  // Internal, and it has to be: a file's permission decision walks this chain looking for an
  // inherited deny, and a chain filtered by what the actor may see would drop the ancestor
  // carrying it.
  const folders = await folderRepository.findByIdsInternal(chainIds);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const folderChain = chainIds
    .map((id) => byId.get(id))
    .filter((folder): folder is FolderRecord => folder !== undefined);

  return {
    file,
    folderChain,
    ancestorAcls: folderChain.map((folder) => ({
      folderId: folder.id,
      acl: folder.permissions as AclEntry[],
      inheritPermissions: folder.inheritPermissions,
    })),
  };
}

export async function requireFile(
  actor: Actor,
  fileId: string,
  permission: Permission,
  options: { includeDeleted?: boolean } = {},
): Promise<FileContext> {
  const context = await loadFileContext(fileId, options);
  if (!context) throw new NotFoundError();

  assertCan(actor, permission, fileResource(context.file), {
    ancestorAcls: context.ancestorAcls,
  });
  return context;
}

export function fileCan(actor: Actor, permission: Permission, context: FileContext): boolean {
  return can(actor, permission, fileResource(context.file), {
    ancestorAcls: context.ancestorAcls,
  });
}

/**
 * What the viewer may do with this file. Re-derived server-side on every request that
 * acts; this list only decides what the interface offers.
 */
export function fileCapabilities(actor: Actor, context: FileContext) {
  const check = (permission: Permission) => fileCan(actor, permission, context);
  // An approved version is read-only: changing it means uploading a new version, which
  // is a different action from editing this one.
  const isApproved = context.file.approvalStatus === 'approved';

  return {
    canPreview: check('file.preview'),
    canDownload: check('file.download'),
    canRename: check('resource.rename') && !isApproved,
    canMove: check('resource.move'),
    canCopy: check('resource.copy'),
    canDelete: check('resource.delete') && !isApproved,
    canArchive: check('resource.archive'),
    canRestore: check('resource.restore'),
    canUploadVersion: check('version.upload'),
    canEditMetadata: check('metadata.edit') && !isApproved,
    canComment: check('comment.create'),
    canShare: check('share.internal'),
    canManageAccess: check('access.manage'),
    canSubmitForReview: check('review.submit') && !isApproved,
    canReview: check('review.perform'),
    canApprove: check('review.approve'),
  };
}
