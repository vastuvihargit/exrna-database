/**
 * Folder operations.
 *
 * Every mutation here follows the same shape: resolve the folder with its ancestor
 * chain, assert the permission against that chain, do the work, then write both an
 * audit row (compliance) and an activity row (the user-facing timeline).
 *
 * Structural rules enforced in this file, because the database cannot express them:
 *   • a folder can never be moved inside itself or one of its own descendants
 *   • drive roots and template folders cannot be renamed, moved or deleted
 *   • two live folders cannot share a name inside one parent (the unique index is the
 *     backstop; the check here produces a useful message instead of a driver error)
 */
import { getEnv } from '@/server/config/env';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/server/errors/app-error';
import { MAX_FOLDER_DEPTH } from '@/server/db/models';
import { withTransaction } from '@/server/db/connection';
import {
  hierarchyMutationEngine,
  moveFolderSubtreeWithFiles,
  restoreFolderSubtreeWithFiles,
  setFolderSubtreeStatusWithFiles,
  trashFolderSubtreeWithFiles,
} from '@/server/db/d1-unit-of-work';
import { isValidDisplayName, nextAvailableName, sanitizeDisplayName } from '@/server/domain/naming';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type { Actor } from '@/server/permissions/actor';
import { auditService } from '@/server/audit/audit.service';
import * as activityRepository from '@/server/repositories/activity.repository';
import * as fileRepository from '@/server/repositories/file.repository';
import * as folderRepository from '@/server/repositories/folder.repository';
import type {
  FolderPatch,
  FolderRecord,
  FolderSortField,
} from '@/server/repositories/folder.repository';
import * as recentRepository from '@/server/repositories/recent-item.repository';
import * as starRepository from '@/server/repositories/star.repository';
import type { RequestMeta } from '@/server/http/request-meta';
import type { HierarchicalStorageProvider } from '@/server/storage/types';
import {
  driveFolderFor,
  driveHierarchy,
  ensureDriveFolder,
  mirrorMove,
  mirrorRename,
  mirrorTrash,
  withDriveMirror,
  NO_MIRROR,
} from './storage-migration/drive-mirror';
import {
  folderCapabilities,
  folderResource,
  loadFolderContext,
  requireFolder,
  toAncestorAcls,
  type FolderContext,
} from './folder-access';
import { can } from '@/server/permissions/authorize';
import { copyFilesForFolderCopy, purgeExpiredTrash as purgeExpiredFiles } from './file.service';
import { detach } from '@/server/runtime/detach';

/** Guard rail on recursive copy: a runaway copy is a denial-of-service on disk. */
const MAX_COPY_FOLDERS = 2000;

export interface FolderView extends FolderRecord {
  isStarred: boolean;
  capabilities: ReturnType<typeof folderCapabilities>;
}

export interface BreadcrumbEntry {
  id: string;
  name: string;
  driveType: string;
  isRoot: boolean;
}

/* ------------------------------------------------------------------ reads */

export async function getFolder(
  actor: Actor,
  folderId: string,
): Promise<{ folder: FolderView; breadcrumbs: BreadcrumbEntry[] }> {
  const context = await requireFolder(actor, folderId, 'file.view');
  const starred = await starRepository.starredIdsAmong(actor.userId, 'folder', [context.folder.id]);

  // Opening a folder is what puts it in Recent. Failing to record that must never
  // fail the read itself.
  detach(
    recentRepository
      .touch({
        userId: actor.userId,
        organizationId: actor.organizationId,
        entityType: 'folder',
        entityId: context.folder.id,
        action: 'opened',
      }),
    'recent.touch',
  );

  return {
    folder: toView(context, actor, starred.has(context.folder.id)),
    breadcrumbs: buildBreadcrumbs(context),
  };
}

export interface ListChildrenInput {
  page: number;
  pageSize: number;
  sort: FolderSortField;
  order: 'asc' | 'desc';
  search?: string;
}

export async function listChildFolders(
  actor: Actor,
  folderId: string,
  input: ListChildrenInput,
): Promise<{ items: FolderView[]; total: number }> {
  const context = await requireFolder(actor, folderId, 'file.view');

  const { items, total } = await folderRepository.listChildrenOf({
    actor,
    parentFolderId: folderId,
    ...(input.search ? { searchPrefix: input.search } : {}),
    page: input.page,
    pageSize: input.pageSize,
    sort: input.sort,
    order: input.order,
  });

  return annotate(actor, context, items, total);
}

/** Shared by every listing that returns folders the actor reached from a known parent. */
async function annotate(
  actor: Actor,
  parent: FolderContext,
  items: FolderRecord[],
  total: number,
): Promise<{ items: FolderView[]; total: number }> {
  const chainForChildren = [
    ...parent.ancestorAcls,
    {
      folderId: parent.folder.id,
      acl: parent.folder.permissions,
      inheritPermissions: parent.folder.inheritPermissions,
    },
  ];

  // Belt and braces: the query already excludes what the actor may not see, and this
  // re-runs the exact decision on every row that came back.
  const visible = items.filter((item) =>
    can(actor, 'file.view', folderResource(item), { ancestorAcls: chainForChildren }),
  );

  const starred = await starRepository.starredIdsAmong(
    actor.userId,
    'folder',
    visible.map((item) => item.id),
  );

  return {
    items: visible.map((item) =>
      toView(
        { folder: item, ancestors: [...parent.ancestors, parent.folder], ancestorAcls: chainForChildren },
        actor,
        starred.has(item.id),
      ),
    ),
    total: total - (items.length - visible.length),
  };
}

export async function getBreadcrumbs(actor: Actor, folderId: string): Promise<BreadcrumbEntry[]> {
  const context = await requireFolder(actor, folderId, 'file.view');
  return buildBreadcrumbs(context);
}

function buildBreadcrumbs(context: FolderContext): BreadcrumbEntry[] {
  return [...context.ancestors, context.folder].map((folder) => ({
    id: folder.id,
    name: folder.name,
    driveType: folder.driveType,
    isRoot: folder.parentFolderId === null,
  }));
}

/* ---------------------------------------------------------------- create */

export interface CreateFolderInput {
  name: string;
  parentFolderId: string;
  description?: string;
  color?: string | null;
  confidentiality?: ConfidentialityLevel;
}

export async function createFolder(
  actor: Actor,
  input: CreateFolderInput,
  meta: RequestMeta,
): Promise<FolderView> {
  const parent = await requireFolder(actor, input.parentFolderId, 'folder.create');

  if (parent.folder.status !== 'active') {
    throw new ConflictError('You cannot create folders inside an archived or trashed folder');
  }
  if (parent.folder.depth + 1 > MAX_FOLDER_DEPTH) {
    throw new ValidationError(`Folders cannot be nested more than ${MAX_FOLDER_DEPTH} levels deep`);
  }

  const name = sanitizeDisplayName(input.name);
  if (!isValidDisplayName(name)) throw new ValidationError('Enter a folder name');

  if (await folderRepository.existsWithName(parent.folder.id, name.toLowerCase())) {
    throw new ConflictError(`A folder named "${name}" already exists here`);
  }

  // A child may never be classified below its parent: that would be a downgrade path
  // around the confidentiality gate.
  const confidentiality = mostRestrictive(
    input.confidentiality ?? parent.folder.confidentiality,
    parent.folder.confidentiality,
  );

  const created = await folderRepository.create({
    organizationId: actor.organizationId,
    name,
    parentFolderId: parent.folder.id,
    pathAncestors: [...parent.folder.pathAncestors, parent.folder.id],
    depth: parent.folder.depth + 1,
    driveType: parent.folder.driveType,
    ownerId: parent.folder.driveType === 'my' ? parent.folder.ownerId : actor.userId,
    departmentId: parent.folder.departmentId,
    projectId: parent.folder.projectId,
    confidentiality,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
    createdBy: actor.userId,
  });

  await folderRepository.adjustChildFolderCount(parent.folder.id, 1);
  await record(actor, meta, created, 'folder.create', { newValue: { name, parentFolderId: parent.folder.id } });

  return toView(
    {
      folder: created,
      ancestors: [...parent.ancestors, parent.folder],
      ancestorAcls: toAncestorAcls([...parent.ancestors, parent.folder]),
    },
    actor,
    false,
  );
}

/* ---------------------------------------------------------------- update */

export async function renameFolder(
  actor: Actor,
  folderId: string,
  rawName: string,
  meta: RequestMeta,
): Promise<FolderView> {
  const context = await requireFolder(actor, folderId, 'resource.rename');
  assertMutable(context.folder);

  const name = sanitizeDisplayName(rawName);
  if (!isValidDisplayName(name)) throw new ValidationError('Enter a folder name');
  if (name === context.folder.name) return toView(context, actor, false);

  const parentId = context.folder.parentFolderId;
  if (parentId && (await folderRepository.existsWithName(parentId, name.toLowerCase(), folderId))) {
    throw new ConflictError(`A folder named "${name}" already exists here`);
  }

  // One Drive call: the mirrored folder itself. Its contents keep their own names.
  const mirror = await planFolderMirror(folderId, (hierarchy, externalId) =>
    mirrorRename({ hierarchy, externalIds: [externalId], from: context.folder.name, to: name }),
  );

  const updated = await withDriveMirror({
    describe: `rename folder ${folderId}`,
    apply: mirror.apply,
    revert: mirror.revert,
    commit: async () => {
      const result = await folderRepository.updateById(folderId, {
        name,
        updatedBy: actor.userId,
      });
      if (!result) throw new NotFoundError();
      return result;
    },
  });

  await record(actor, meta, updated, 'folder.rename', {
    previousValue: { name: context.folder.name },
    newValue: { name },
  });

  return toView({ ...context, folder: updated }, actor, false);
}

/**
 * Builds the Drive half of a folder operation, or a no-op.
 *
 * A folder is a *single* Drive object and Drive cascades, so moving or trashing it carries
 * everything inside — one call regardless of how many thousands of files are in the subtree.
 * That is the only reason folder operations are viable to mirror synchronously at all.
 *
 * Returns a no-op when the folder has never been mirrored, which is the ordinary state for
 * an empty folder: mirroring is lazy (decision D7), so a Drive counterpart appears the first
 * time content needs to land in it and not before.
 */
async function planFolderMirror(
  folderId: string,
  build: (
    hierarchy: HierarchicalStorageProvider,
    externalId: string,
  ) => { apply: () => Promise<void>; revert: () => Promise<void> } | Promise<{ apply: () => Promise<void>; revert: () => Promise<void> }>,
): Promise<{ apply: () => Promise<void>; revert: () => Promise<void> }> {
  const hierarchy = driveHierarchy();
  if (!hierarchy) return NO_MIRROR;

  const externalId = await driveFolderFor(folderId);
  if (!externalId) return NO_MIRROR;

  return build(hierarchy, externalId);
}

export interface UpdateFolderInput {
  description?: string;
  color?: string | null;
  confidentiality?: ConfidentialityLevel;
  inheritPermissions?: boolean;
}

export async function updateFolder(
  actor: Actor,
  folderId: string,
  input: UpdateFolderInput,
  meta: RequestMeta,
): Promise<FolderView> {
  const context = await requireFolder(actor, folderId, 'metadata.edit');

  const update: FolderPatch = { updatedBy: actor.userId };
  if (input.description !== undefined) update.description = input.description;
  if (input.color !== undefined) update.color = input.color;

  if (input.confidentiality !== undefined) {
    const parent = context.ancestors.at(-1);
    update.confidentiality = parent
      ? mostRestrictive(input.confidentiality, parent.confidentiality)
      : input.confidentiality;
  }
  // Breaking inheritance is an access-control change, not a metadata edit.
  if (input.inheritPermissions !== undefined) {
    if (!can(actor, 'access.manage', folderResource(context.folder), { ancestorAcls: context.ancestorAcls })) {
      throw new ForbiddenError('You cannot change permission inheritance on this folder');
    }
    update.inheritPermissions = input.inheritPermissions;
  }

  const updated = await folderRepository.updateById(folderId, update);
  if (!updated) throw new NotFoundError();

  await record(actor, meta, updated, 'file.metadata_updated', {
    previousValue: {
      description: context.folder.description,
      confidentiality: context.folder.confidentiality,
      inheritPermissions: context.folder.inheritPermissions,
    },
    newValue: update,
  });

  return toView({ ...context, folder: updated }, actor, false);
}

/* ------------------------------------------------------------------ move */

export async function moveFolder(
  actor: Actor,
  folderId: string,
  targetParentId: string,
  meta: RequestMeta,
): Promise<FolderView> {
  const context = await requireFolder(actor, folderId, 'resource.move');
  assertMutable(context.folder);

  if (folderId === targetParentId) {
    throw new ConflictError('A folder cannot be moved into itself', 'CIRCULAR_MOVE');
  }

  const target = await requireFolder(actor, targetParentId, 'folder.create');
  if (target.folder.status !== 'active') {
    throw new ConflictError('The destination folder is archived or in the trash');
  }

  // The decisive check: the destination must not be the folder itself or anything
  // below it. Its ancestor chain is already loaded, so this costs nothing.
  if (target.folder.pathAncestors.includes(folderId)) {
    throw new ConflictError('A folder cannot be moved into one of its own subfolders', 'CIRCULAR_MOVE');
  }
  if (context.folder.parentFolderId === targetParentId) {
    return toView(context, actor, false);
  }

  const subtreeDepth = await maxSubtreeDepth(context.folder);
  const newDepth = target.folder.depth + 1 + subtreeDepth;
  if (newDepth > MAX_FOLDER_DEPTH) {
    throw new ValidationError(`That move would nest folders more than ${MAX_FOLDER_DEPTH} levels deep`);
  }

  if (
    await folderRepository.existsWithName(
      target.folder.id,
      context.folder.name.toLowerCase(),
      folderId,
    )
  ) {
    throw new ConflictError(`A folder named "${context.folder.name}" already exists in the destination`);
  }

  /**
   * One Drive call moves the whole subtree, because Drive folders cascade. The destination
   * is mirrored first if it is not already — otherwise there is nowhere to move it to.
   */
  const mirror = await planFolderMirror(folderId, async (hierarchy, externalId) => {
    const toParent = await ensureDriveFolder(target.folder.id, hierarchy);
    const fromParent = context.folder.parentFolderId
      ? await driveFolderFor(context.folder.parentFolderId)
      : null;
    return mirrorMove({ hierarchy, externalIds: [externalId], fromParent, toParent });
  });

  await withDriveMirror({
    describe: `move folder ${folderId}`,
    apply: mirror.apply,
    revert: mirror.revert,
    commit: () => moveFolderRecords(),
  });

  /**
   * The hierarchy write, dispatched on which databases are actually serving.
   *
   * A folder move rewrites two hierarchies that must agree — the folder tree and every
   * contained file's ancestor chain — and the mechanism that keeps them in step is different
   * for each engine. MongoDB has an interactive transaction; D1 has one prebuilt batch. There
   * is no mechanism at all that spans both, which is why a split configuration is refused
   * rather than attempted.
   */
  async function moveFolderRecords(): Promise<void> {
    const moveInput = {
      folderId,
      newParentId: target.folder.id,
      newPathAncestors: [...target.folder.pathAncestors, target.folder.id],
      driveType: target.folder.driveType,
      departmentId: target.folder.departmentId,
      projectId: target.folder.projectId,
      // Moving into a personal drive transfers ownership to that drive's owner;
      // anywhere else the folder keeps its own owner.
      ownerId: target.folder.driveType === 'my' ? target.folder.ownerId : context.folder.ownerId,
      updatedBy: actor.userId,
    };

    // Fails closed on a split configuration. Committing the folder half to one database and
    // then attempting the file half against another is the exact inconsistency this design
    // removes, with a wider window. Reads are unaffected; only this mutation is refused.
    if (hierarchyMutationEngine('move') === 'd1') {
      // One batch: folders, folder_ancestors, files, file_folder_ancestors and both child
      // counts commit together or not at all. No Mongo session is opened — `withTransaction`
      // would start one and it would govern none of these statements.
      await moveFolderSubtreeWithFiles({
        ...moveInput,
        previousParentId: context.folder.parentFolderId,
      });
      return;
    }

    await withTransaction(async (session) => {
      await folderRepository.moveSubtree(moveInput, session);
      // Files carry a denormalized copy of their folder's ancestor path, so they move
      // with it in the same transaction — otherwise a subtree search would miss them.
      await fileRepository.reparentSubtree(
        {
          folderId,
          newPathAncestorsForFolder: [...target.folder.pathAncestors, target.folder.id],
          driveType: target.folder.driveType,
          departmentId: target.folder.departmentId,
          projectId: target.folder.projectId,
        },
        session,
      );

      if (context.folder.parentFolderId) {
        await folderRepository.adjustChildFolderCount(context.folder.parentFolderId, -1, session);
      }
      await folderRepository.adjustChildFolderCount(target.folder.id, 1, session);
    });
  }

  // Internal on purpose: `resource.move` was asserted on this folder at the top of the
  // request, and the row being re-read is the one this request has just written.
  const moved = await folderRepository.findByIdInternal(folderId);
  if (!moved) throw new NotFoundError();

  await record(actor, meta, moved, 'folder.move', {
    previousValue: { parentFolderId: context.folder.parentFolderId },
    newValue: { parentFolderId: target.folder.id },
  });

  return toView(
    {
      folder: moved,
      ancestors: [...target.ancestors, target.folder],
      ancestorAcls: toAncestorAcls([...target.ancestors, target.folder]),
    },
    actor,
    false,
  );
}

async function maxSubtreeDepth(folder: FolderRecord): Promise<number> {
  const descendants = await folderRepository.listDescendantsInternal(folder.id);
  if (descendants.length === 0) return 0;
  return Math.max(...descendants.map((d) => d.depth)) - folder.depth;
}

/* ------------------------------------------------------------------ copy */

export async function copyFolder(
  actor: Actor,
  folderId: string,
  targetParentId: string,
  meta: RequestMeta,
): Promise<FolderView> {
  const context = await requireFolder(actor, folderId, 'resource.copy');
  const target = await requireFolder(actor, targetParentId, 'folder.create');

  if (target.folder.pathAncestors.includes(folderId) || target.folder.id === folderId) {
    throw new ConflictError('A folder cannot be copied into itself', 'CIRCULAR_MOVE');
  }

  const descendants = await folderRepository.listDescendantsInternal(folderId);
  if (descendants.length + 1 > MAX_COPY_FOLDERS) {
    throw new ValidationError(
      `That folder contains more than ${MAX_COPY_FOLDERS} subfolders, which is too many to copy in one operation`,
    );
  }

  const taken = await folderRepository.takenChildNames(target.folder.id);
  const name = nextAvailableName(context.folder.name, taken);

  const copy = await folderRepository.create({
    organizationId: actor.organizationId,
    name,
    parentFolderId: target.folder.id,
    pathAncestors: [...target.folder.pathAncestors, target.folder.id],
    depth: target.folder.depth + 1,
    driveType: target.folder.driveType,
    ownerId: target.folder.driveType === 'my' ? target.folder.ownerId : actor.userId,
    departmentId: target.folder.departmentId,
    projectId: target.folder.projectId,
    confidentiality: mostRestrictive(context.folder.confidentiality, target.folder.confidentiality),
    description: context.folder.description,
    color: context.folder.color,
    createdBy: actor.userId,
  });

  // Copy the subtree breadth-first so a parent always exists before its children.
  // ACLs are deliberately *not* copied: a copy inherits its new location's access,
  // otherwise copying is a way to carry a share into a place it was never granted.
  const idMap = new Map<string, string>([[folderId, copy.id]]);
  const ordered = [...descendants].sort((a, b) => a.depth - b.depth);
  for (const descendant of ordered) {
    const newParentId = descendant.parentFolderId ? idMap.get(descendant.parentFolderId) : undefined;
    if (!newParentId) continue; // Parent was skipped; skip the branch with it.
    // Internal: this is a folder the loop created moments ago, inside a copy the actor is
    // already authorized for.
    const parentRecord = await folderRepository.findByIdInternal(newParentId);
    if (!parentRecord) continue;

    const createdChild = await folderRepository.create({
      organizationId: actor.organizationId,
      name: descendant.name,
      parentFolderId: newParentId,
      pathAncestors: [...parentRecord.pathAncestors, parentRecord.id],
      depth: parentRecord.depth + 1,
      driveType: copy.driveType,
      ownerId: copy.ownerId,
      departmentId: copy.departmentId,
      projectId: copy.projectId,
      confidentiality: mostRestrictive(descendant.confidentiality, copy.confidentiality),
      description: descendant.description,
      color: descendant.color,
      createdBy: actor.userId,
    });
    idMap.set(descendant.id, createdChild.id);
  }

  await folderRepository.adjustChildFolderCount(target.folder.id, 1);

  // Files are copied after the folder skeleton exists, so every destination is already
  // there. `copyFilesForFolderCopy` skips what it cannot copy rather than unwinding the
  // whole operation.
  const fileResult = await copyFilesForFolderCopy(actor, idMap, meta);

  await record(actor, meta, copy, 'folder.copy', {
    previousValue: { sourceFolderId: folderId },
    newValue: {
      name: copy.name,
      parentFolderId: target.folder.id,
      copiedFolders: idMap.size,
      copiedFiles: fileResult.copied,
      skippedFiles: fileResult.skipped,
    },
  });

  return toView(
    {
      folder: copy,
      ancestors: [...target.ancestors, target.folder],
      ancestorAcls: toAncestorAcls([...target.ancestors, target.folder]),
    },
    actor,
    false,
  );
}

/* --------------------------------------------------------- trash & archive */

export async function trashFolder(
  actor: Actor,
  folderId: string,
  meta: RequestMeta,
): Promise<{ affected: number; affectedFiles: number }> {
  const context = await requireFolder(actor, folderId, 'resource.delete');
  assertMutable(context.folder);

  /**
   * One Drive call trashes the whole subtree. Google's own trash, not a delete: the
   * contents stay recoverable there for the same reason they stay recoverable here, and a
   * restore is the exact inverse.
   */
  const mirror = await planFolderMirror(folderId, (hierarchy, externalId) =>
    mirrorTrash({ hierarchy, externalIds: [externalId], trashed: true }),
  );

  const affected = await withDriveMirror({
    describe: `trash folder ${folderId}`,
    apply: mirror.apply,
    revert: mirror.revert,
    commit: () => trashFolderRecords(),
  });

  async function trashFolderRecords(): Promise<{ folders: number; files: number }> {
    // Fails closed on a split configuration, exactly as a move does: the folder half would
    // commit to one database and the file half to another.
    if (hierarchyMutationEngine('trash') === 'd1') {
      return trashFolderSubtreeWithFiles({
        folderId,
        userId: actor.userId,
        parentFolderId: context.folder.parentFolderId,
      });
    }

    return withTransaction(async (session) => {
    const count = await folderRepository.setSubtreeDeleted(
      { folderId, deleted: true, userId: actor.userId },
      session,
    );
    // Files go to the trash with the folder that held them, tagged with which deletion
    // swept them in so the restore brings back exactly that set.
    const files = await fileRepository.setSubtreeDeleted(
      { folderId, deleted: true, userId: actor.userId },
      session,
    );
    if (context.folder.parentFolderId) {
      await folderRepository.adjustChildFolderCount(context.folder.parentFolderId, -1, session);
    }
    return { folders: count, files };
    });
  }

  await record(actor, meta, context.folder, 'resource.delete', {
    newValue: {
      affectedFolders: affected.folders,
      affectedFiles: affected.files,
      retentionDays: getEnv().TRASH_RETENTION_DAYS,
    },
    severity: 'warning',
  });

  return { affected: affected.folders, affectedFiles: affected.files };
}

export async function restoreFolder(
  actor: Actor,
  folderId: string,
  meta: RequestMeta,
): Promise<FolderView> {
  const context = await requireFolder(actor, folderId, 'resource.restore', { includeDeleted: true });
  if (!context.folder.deletedAt) return toView(context, actor, false);

  // Restoring into a parent that is itself in the trash would leave the folder
  // unreachable, so it goes back to the drive root instead.
  // Internal: the question is whether the *parent* is still in the trash, and the answer must
  // not depend on whether the restorer can see it — a folder the actor may not view can still
  // be the reason their restore has to wait.
  const parent = context.folder.parentFolderId
    ? await folderRepository.findByIdInternal(context.folder.parentFolderId, {
        includeDeleted: true,
      })
    : null;
  if (parent?.deletedAt) {
    throw new ConflictError(
      `Restore "${parent.name}" first — this folder was inside it when it was deleted`,
    );
  }

  if (
    context.folder.parentFolderId &&
    (await folderRepository.existsWithName(
      context.folder.parentFolderId,
      context.folder.name.toLowerCase(),
      folderId,
    ))
  ) {
    throw new ConflictError(
      `A folder named "${context.folder.name}" was created here after this one was deleted. Rename one of them first.`,
    );
  }

  const mirror = await planFolderMirror(folderId, (hierarchy, externalId) =>
    mirrorTrash({ hierarchy, externalIds: [externalId], trashed: false }),
  );

  const affected = await withDriveMirror({
    describe: `restore folder ${folderId}`,
    apply: mirror.apply,
    revert: mirror.revert,
    commit: () => restoreFolderRecords(),
  });

  async function restoreFolderRecords(): Promise<number> {
    if (hierarchyMutationEngine('restore') === 'd1') {
      const counts = await restoreFolderSubtreeWithFiles({
        folderId,
        userId: actor.userId,
        parentFolderId: context.folder.parentFolderId,
      });
      return counts.folders;
    }

    return withTransaction(async (session) => {
    const count = await folderRepository.setSubtreeDeleted(
      { folderId, deleted: false, userId: actor.userId },
      session,
    );
    await fileRepository.setSubtreeDeleted(
      { folderId, deleted: false, userId: actor.userId },
      session,
    );
    if (context.folder.parentFolderId) {
      await folderRepository.adjustChildFolderCount(context.folder.parentFolderId, 1, session);
    }
    return count;
    });
  }

  const restored = await folderRepository.findByIdInternal(folderId);
  if (!restored) throw new NotFoundError();

  await record(actor, meta, restored, 'resource.restore', {
    newValue: { affectedFolders: affected },
    severity: 'notice',
  });

  return toView({ ...context, folder: restored }, actor, false);
}

export async function setArchived(
  actor: Actor,
  folderId: string,
  archived: boolean,
  meta: RequestMeta,
): Promise<FolderView> {
  const context = await requireFolder(actor, folderId, archived ? 'resource.archive' : 'resource.restore');
  assertMutable(context.folder);

  const status = archived ? ('archived' as const) : ('active' as const);

  if (hierarchyMutationEngine(archived ? 'archive' : 'unarchive') === 'd1') {
    await setFolderSubtreeStatusWithFiles({ folderId, status, userId: actor.userId });
  } else {
    await withTransaction(async (session) => {
      await folderRepository.setSubtreeStatus({ folderId, status, userId: actor.userId }, session);
      await fileRepository.setSubtreeStatus({ folderId, status }, session);
    });
  }

  const updated = await folderRepository.findByIdInternal(folderId);
  if (!updated) throw new NotFoundError();

  await record(actor, meta, updated, archived ? 'resource.archive' : 'resource.restore', {
    newValue: { status: updated.status },
  });

  return toView({ ...context, folder: updated }, actor, false);
}

/* ----------------------------------------------------------- trash listing */

export async function listTrash(
  actor: Actor,
  input: { page: number; pageSize: number },
): Promise<{ items: FolderView[]; total: number }> {
  // Only what the user deleted themselves — descendants swept in with a parent are
  // restored with it and would be noise here.
  const { items, total } = await folderRepository.listTrashed({
    actor,
    page: input.page,
    pageSize: input.pageSize,
  });

  const views = await Promise.all(
    items.map(async (item) => {
      const context = await loadFolderContext(actor, item.id, { includeDeleted: true });
      return context ? toView(context, actor, false) : null;
    }),
  );

  return { items: views.filter((view): view is FolderView => view !== null), total };
}

export async function listArchive(
  actor: Actor,
  input: { page: number; pageSize: number },
): Promise<{ items: FolderView[]; total: number }> {
  const { items, total } = await folderRepository.listArchived({
    actor,
    page: input.page,
    pageSize: input.pageSize,
  });

  const views = await Promise.all(
    items.map(async (item) => {
      const context = await loadFolderContext(actor, item.id);
      return context ? toView(context, actor, false) : null;
    }),
  );

  return { items: views.filter((view): view is FolderView => view !== null), total };
}

/**
 * Purges folders whose retention window has passed. Called by the scheduled job, never
 * by a request. Files inside them are purged by the file service from Phase 4.
 */
export async function purgeExpiredTrash(): Promise<{
  purged: number;
  purgedFiles: number;
  reclaimedBytes: number;
}> {
  // Files first: they hold the bytes, and a folder row is worthless without them but a
  // stored object with no metadata row is unreachable rubbish.
  const fileResult = await purgeExpiredFiles();

  const env = getEnv();
  const cutoff = new Date(Date.now() - env.TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await folderRepository.findExpiredTrashInternal(cutoff);
  if (expired.length === 0) {
    return { purged: 0, purgedFiles: fileResult.files, reclaimedBytes: fileResult.bytes };
  }

  const ids = expired.map((folder) => folder.id);
  await starRepository.removeAllFor('folder', ids);
  await recentRepository.removeAllFor('folder', ids);
  const purged = await folderRepository.purge(ids);
  return { purged, purgedFiles: fileResult.files, reclaimedBytes: fileResult.bytes };
}

/* ------------------------------------------------------------------ stars */

export async function setStarred(
  actor: Actor,
  folderId: string,
  starred: boolean,
): Promise<{ isStarred: boolean }> {
  await requireFolder(actor, folderId, 'file.view');
  if (starred) {
    await starRepository.add({
      userId: actor.userId,
      organizationId: actor.organizationId,
      entityType: 'folder',
      entityId: folderId,
    });
  } else {
    await starRepository.remove({ userId: actor.userId, entityType: 'folder', entityId: folderId });
  }
  return { isStarred: starred };
}

export async function listStarred(actor: Actor): Promise<FolderView[]> {
  const stars = await starRepository.listForUser(actor.userId, { entityType: 'folder' });
  return resolveMany(actor, stars.map((star) => star.entityId));
}

export async function listRecent(actor: Actor): Promise<FolderView[]> {
  const recent = await recentRepository.listForUser(actor.userId, { entityType: 'folder' });
  return resolveMany(actor, recent.map((entry) => entry.entityId));
}

/**
 * Loads folders by id and drops the ones the actor may no longer see.
 *
 * Access can be revoked after a folder was starred or opened, so these lists are
 * re-authorized on every read rather than trusted because the row exists.
 */
async function resolveMany(actor: Actor, ids: string[]): Promise<FolderView[]> {
  const contexts = await Promise.all(ids.map((id) => loadFolderContext(actor, id)));
  const views: FolderView[] = [];
  const starred = await starRepository.starredIdsAmong(actor.userId, 'folder', ids);

  for (const context of contexts) {
    if (!context) continue;
    if (!can(actor, 'file.view', folderResource(context.folder), { ancestorAcls: context.ancestorAcls })) {
      continue;
    }
    views.push(toView(context, actor, starred.has(context.folder.id)));
  }
  return views;
}

/* --------------------------------------------------------------- helpers */

function toView(context: FolderContext, actor: Actor, isStarred: boolean): FolderView {
  return {
    ...context.folder,
    isStarred,
    capabilities: folderCapabilities(actor, context),
  };
}

function assertMutable(folder: FolderRecord): void {
  if (folder.isSystem) {
    throw new ForbiddenError('Drive roots and template folders cannot be renamed, moved or deleted');
  }
}

const CONFIDENTIALITY_ORDER: ConfidentialityLevel[] = [
  'public_internal',
  'internal',
  'confidential',
  'restricted',
];

function mostRestrictive(a: ConfidentialityLevel, b: ConfidentialityLevel): ConfidentialityLevel {
  return CONFIDENTIALITY_ORDER.indexOf(a) >= CONFIDENTIALITY_ORDER.indexOf(b) ? a : b;
}

async function record(
  actor: Actor,
  meta: RequestMeta,
  folder: FolderRecord,
  action: Parameters<typeof auditService.recordForActor>[2]['action'],
  extra: {
    previousValue?: unknown;
    newValue?: unknown;
    severity?: 'info' | 'notice' | 'warning' | 'critical';
  } = {},
): Promise<void> {
  await auditService.recordForActor(actor, meta, {
    action,
    entityType: 'folder',
    entityId: folder.id,
    entityLabel: folder.name,
    ...extra,
  });

  // The activity feed is best-effort: it is a convenience, not the compliance record.
  detach(
    activityRepository
      .append({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorName: actor.name,
        action,
        entityType: 'folder',
        entityId: folder.id,
        entityLabel: folder.name,
        contextFolderIds: folder.pathAncestors,
        departmentId: folder.departmentId,
        projectId: folder.projectId,
      }),
    'activity.append',
  );
}

export const folderService = {
  getFolder,
  listChildFolders,
  getBreadcrumbs,
  createFolder,
  renameFolder,
  updateFolder,
  moveFolder,
  copyFolder,
  trashFolder,
  restoreFolder,
  setArchived,
  listTrash,
  listArchive,
  purgeExpiredTrash,
  setStarred,
  listStarred,
  listRecent,
};
