/**
 * File operations that do not move bytes: listing, renaming, moving between folders,
 * copying, starring, trashing and restoring.
 *
 * Uploading is `upload.service.ts`; reading bytes is `download.service.ts` (Phase 5).
 * Keeping them apart means the only two modules that touch storage are the two that
 * have to.
 */
import { getEnv } from '@/server/config/env';
import { withTransaction } from '@/server/db/connection';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/server/errors/app-error';
import { isValidDisplayName, nextAvailableName, sanitizeDisplayName } from '@/server/domain/naming';
import { isPreviewable, type FileCategory } from '@/server/domain/file-types';
import { CONFIDENTIALITY_RANK, type ConfidentialityLevel } from '@/server/domain/permissions';
import { validateResearchMetadata } from '@/server/domain/research-metadata';
import { actorClearance, type Actor } from '@/server/permissions/actor';
import { can } from '@/server/permissions/authorize';
import { auditService } from '@/server/audit/audit.service';
import * as activityRepository from '@/server/repositories/activity.repository';
import * as commentRepository from '@/server/repositories/comment.repository';
import * as notificationRepository from '@/server/repositories/notification.repository';
import * as fileRepository from '@/server/repositories/file.repository';
import type { FilePatch, FileRecord, FileSortField } from '@/server/repositories/file.repository';
import * as versionRepository from '@/server/repositories/file-version.repository';
import * as folderRepository from '@/server/repositories/folder.repository';
import type { FolderRecord } from '@/server/repositories/folder.repository';
import * as projectRepository from '@/server/repositories/project.repository';
import * as recentRepository from '@/server/repositories/recent-item.repository';
import * as reviewRepository from '@/server/repositories/review.repository';
import * as starRepository from '@/server/repositories/star.repository';
import * as usageRepository from '@/server/repositories/storage-usage.repository';
import { getObjectStore } from '@/server/storage';
import {
  assertMirrorableCount,
  driveFolderFor,
  driveHierarchy,
  driveObjectsForFile,
  ensureDriveFolder,
  mirrorMove,
  mirrorRename,
  mirrorTrash,
  withDriveMirror,
  NO_MIRROR,
} from './storage-migration/drive-mirror';
import { buildOriginalKey, newStorageId } from '@/server/storage/keys';
import type { RequestMeta } from '@/server/http/request-meta';
import type { AuditAction } from '@/server/db/models';
import {
  fileCan,
  fileCapabilities,
  fileResource,
  loadFileContext,
  requireFile,
  type FileContext,
} from './file-access';
import { requireFolder } from './folder-access';
import { experimentService } from './experiment.service';

export interface FileView extends FileRecord {
  isStarred: boolean;
  previewable: boolean;
  capabilities: ReturnType<typeof fileCapabilities>;
}

/* ------------------------------------------------------------------ reads */

export async function getFile(actor: Actor, fileId: string): Promise<FileView> {
  const context = await requireFile(actor, fileId, 'file.view');
  const starred = await starRepository.starredIdsAmong(actor.userId, 'file', [fileId]);

  void recentRepository
    .touch({
      userId: actor.userId,
      organizationId: actor.organizationId,
      entityType: 'file',
      entityId: fileId,
      action: 'opened',
    })
    .catch(() => undefined);

  return toView(context, actor, starred.has(fileId));
}

export interface ListFilesInput {
  page: number;
  pageSize: number;
  sort: FileSortField;
  order: 'asc' | 'desc';
  search?: string;
}

export async function listInFolder(
  actor: Actor,
  folderId: string,
  input: ListFilesInput,
): Promise<{ items: FileView[]; total: number }> {
  const folder = await requireFolder(actor, folderId, 'file.view');

  const { items, total } = await fileRepository.listInFolder({
    actor,
    folderId,
    ...(input.search ? { searchPrefix: input.search } : {}),
    page: input.page,
    pageSize: input.pageSize,
    sort: input.sort,
    order: input.order,
  });

  const chain = [
    ...folder.ancestorAcls,
    {
      folderId: folder.folder.id,
      acl: folder.folder.permissions,
      inheritPermissions: folder.folder.inheritPermissions,
    },
  ];

  // The query already excludes what the actor may not see; this re-runs the exact
  // decision per row so a filter that drifts from the rules cannot leak anything.
  const visible = items.filter((item) =>
    can(actor, 'file.view', fileResource(item), { ancestorAcls: chain }),
  );
  const starred = await starRepository.starredIdsAmong(
    actor.userId,
    'file',
    visible.map((item) => item.id),
  );

  return {
    items: visible.map((item) =>
      toView(
        { file: item, folderChain: [...folder.ancestors, folder.folder], ancestorAcls: chain },
        actor,
        starred.has(item.id),
      ),
    ),
    total: total - (items.length - visible.length),
  };
}

export async function listVersions(actor: Actor, fileId: string) {
  await requireFile(actor, fileId, 'file.view');
  return versionRepository.listForFile(fileId);
}

/* ---------------------------------------------------------------- mutate */

export async function renameFile(
  actor: Actor,
  fileId: string,
  rawName: string,
  meta: RequestMeta,
): Promise<FileView> {
  const context = await requireFile(actor, fileId, 'resource.rename');
  assertNotApproved(context, 'renamed');

  const displayName = sanitizeDisplayName(rawName);
  if (!isValidDisplayName(displayName)) throw new ValidationError('Enter a file name');
  if (displayName === context.file.displayName) return toView(context, actor, false);

  if (await fileRepository.existsWithName(context.file.folderId, displayName.toLowerCase(), fileId)) {
    throw new ConflictError(`A file named "${displayName}" already exists in this folder`);
  }

  // Drive first, then the database (see drive-mirror.ts). A Drive failure here leaves both
  // sides at the original name and the user sees a plain error.
  const mirror = await planFileRename(fileId, context.file.displayName, displayName);

  const updated = await withDriveMirror({
    describe: `rename file ${fileId}`,
    apply: mirror.apply,
    revert: mirror.revert,
    commit: async () => {
      // `displayNameLower` is written by the repository alongside `displayName`, so the
      // two cannot disagree.
      const result = await fileRepository.updateById(fileId, {
        displayName,
        updatedBy: actor.userId,
      });
      if (!result) throw new NotFoundError();
      return result;
    },
  });

  await record(actor, meta, updated, 'file.rename', {
    previousValue: { displayName: context.file.displayName },
    newValue: { displayName },
  });

  return toView({ ...context, file: updated }, actor, false);
}

/**
 * The Drive half of a file rename: every migrated version's object takes the new name.
 *
 * All of them, not just the current one, so a person browsing the Shared Drive sees one
 * consistently-named set rather than a history of what the file used to be called.
 */
async function planFileRename(
  fileId: string,
  from: string,
  to: string,
): Promise<{ apply: () => Promise<void>; revert: () => Promise<void> }> {
  const hierarchy = driveHierarchy();
  if (!hierarchy) return NO_MIRROR;

  const externalIds = await driveObjectsForFile(fileId);
  if (externalIds.length === 0) return NO_MIRROR;
  assertMirrorableCount(externalIds.length);

  return mirrorRename({ hierarchy, externalIds, from, to });
}

export async function moveFile(
  actor: Actor,
  fileId: string,
  targetFolderId: string,
  meta: RequestMeta,
): Promise<FileView> {
  const context = await requireFile(actor, fileId, 'resource.move');
  const target = await requireFolder(actor, targetFolderId, 'file.upload');

  if (target.folder.status !== 'active') {
    throw new ConflictError('The destination folder is archived or in the trash');
  }
  if (context.file.folderId === targetFolderId) return toView(context, actor, false);

  if (await fileRepository.existsWithName(targetFolderId, context.file.displayName.toLowerCase())) {
    throw new ConflictError(
      `A file named "${context.file.displayName}" already exists in the destination`,
    );
  }

  const previousDepartmentId = context.file.departmentId;
  const previousProjectId = context.file.projectId;

  // The destination's Drive folder is created here if it does not exist yet — the same lazy
  // mirroring an upload into that folder would have triggered.
  const mirror = await planFileMove(fileId, context.file.folderId, targetFolderId);

  const updated = await withDriveMirror({
    describe: `move file ${fileId}`,
    apply: mirror.apply,
    revert: mirror.revert,
    commit: () => moveFileRecords(),
  });

  async function moveFileRecords(): Promise<FileRecord> {
    return withTransaction(async (session) => {
    const moved = await fileRepository.updateById(
      fileId,
      {
        folderId: target.folder.id,
        folderPathAncestors: [...target.folder.pathAncestors, target.folder.id],
        driveType: target.folder.driveType,
        departmentId: target.folder.departmentId,
        projectId: target.folder.projectId,
        ownerId: target.folder.driveType === 'my' ? target.folder.ownerId : context.file.ownerId,
        updatedBy: actor.userId,
      },
      session,
    );
    if (!moved) throw new NotFoundError();

    await folderRepository.updateById(context.file.folderId, { fileCountDelta: -1 }, session);
    await folderRepository.updateById(target.folder.id, { fileCountDelta: 1 }, session);

    // Storage accounting follows the file: moving between departments moves the bytes
    // from one department's quota to the other's.
    const bytes = await totalVersionBytes(fileId);
    if (previousDepartmentId !== target.folder.departmentId || previousProjectId !== target.folder.projectId) {
      await usageRepository.applyDelta(
        {
          userId: moved.ownerId,
          departmentId: previousDepartmentId,
          projectId: previousProjectId,
          bytes: -bytes,
        },
        session,
      );
      await usageRepository.applyDelta(
        {
          userId: moved.ownerId,
          departmentId: target.folder.departmentId,
          projectId: target.folder.projectId,
          bytes,
        },
        session,
      );
    }

    return moved;
    });
  }

  await record(actor, meta, updated, 'file.move', {
    previousValue: { folderId: context.file.folderId },
    newValue: { folderId: target.folder.id },
  });

  return toView({ ...context, file: updated }, actor, false);
}

/**
 * The Drive folder a copy should land in, mirrored if it does not exist yet.
 *
 * Returns undefined when Drive is not in play, which leaves the copy call exactly as it was
 * before this phase.
 */
async function ensureDriveParentFor(folderId: string): Promise<string | undefined> {
  const hierarchy = driveHierarchy();
  if (!hierarchy) return undefined;
  return ensureDriveFolder(folderId, hierarchy);
}

/**
 * The Drive half of a file move: every migrated version's object changes parent.
 *
 * All of them, or a file's objects end up scattered across two Drive folders with no record
 * that they belong together.
 */
async function planFileMove(
  fileId: string,
  fromFolderId: string,
  toFolderId: string,
): Promise<{ apply: () => Promise<void>; revert: () => Promise<void> }> {
  const hierarchy = driveHierarchy();
  if (!hierarchy) return NO_MIRROR;

  const externalIds = await driveObjectsForFile(fileId);
  if (externalIds.length === 0) return NO_MIRROR;
  assertMirrorableCount(externalIds.length);

  const toParent = await ensureDriveFolder(toFolderId, hierarchy);
  const fromParent = await driveFolderFor(fromFolderId);

  return mirrorMove({ hierarchy, externalIds, fromParent, toParent });
}

/**
 * Copies the current version only.
 *
 * Deliberate: a copy is a new working document, not a duplicate of an audit trail. The
 * original's version history, review decisions and sharing stay with the original,
 * which is what keeps "who approved what" unambiguous.
 */
export async function copyFile(
  actor: Actor,
  fileId: string,
  targetFolderId: string,
  meta: RequestMeta,
): Promise<FileView> {
  const context = await requireFile(actor, fileId, 'resource.copy');
  const target = await requireFolder(actor, targetFolderId, 'file.upload');
  const created = await performCopy(actor, context, target.folder, meta);

  const refreshed = await loadFileContext(actor, created.id);
  return toView(refreshed ?? { ...context, file: created }, actor, false);
}

/**
 * Copies the files inside a folder subtree that has just been copied.
 *
 * `folderIdMap` maps each source folder to its new counterpart. Files whose copy fails
 * — quota, missing bytes — are skipped and counted rather than aborting the whole
 * operation: a partially copied folder the user can see is more useful than a rollback
 * of a hundred successful copies.
 */
export async function copyFilesForFolderCopy(
  actor: Actor,
  folderIdMap: Map<string, string>,
  meta: RequestMeta,
): Promise<{ copied: number; skipped: number }> {
  let copied = 0;
  let skipped = 0;

  for (const [sourceFolderId, targetFolderId] of folderIdMap) {
    // Internal: the destination was created by this same copy, moments ago, inside an
    // operation the actor is already authorized for.
    const targetFolder = await folderRepository.findByIdInternal(targetFolderId);
    if (!targetFolder) continue;

    const { items } = await fileRepository.listInFolder({
      actor,
      folderId: sourceFolderId,
      page: 1,
      pageSize: 500,
      sort: 'displayName',
      order: 'asc',
    });

    for (const file of items) {
      const context = await loadFileContext(actor, file.id);
      if (!context) continue;
      if (!can(actor, 'resource.copy', fileResource(file), { ancestorAcls: context.ancestorAcls })) {
        skipped += 1;
        continue;
      }
      try {
        await performCopy(actor, context, targetFolder, meta);
        copied += 1;
      } catch {
        skipped += 1;
      }
    }
  }

  return { copied, skipped };
}

async function performCopy(
  actor: Actor,
  context: FileContext,
  targetFolder: FolderRecord,
  meta: RequestMeta,
): Promise<FileRecord> {
  const target = { folder: targetFolder };
  const sourceVersion = context.file.currentVersionId
    ? await versionRepository.findById(context.file.currentVersionId)
    : null;
  const location = context.file.currentVersionId
    ? await versionRepository.getStorageLocation(context.file.currentVersionId)
    : null;
  if (!sourceVersion || !location) {
    throw new ConflictError('This file has no stored content to copy');
  }

  await assertRoomFor(actor, target.folder.departmentId, sourceVersion.fileSize);

  const taken = await fileRepository.takenNamesInFolder(target.folder.id);
  const displayName = nextAvailableName(context.file.displayName, taken);

  const newFileId = fileRepository.newId();
  const storage = getObjectStore(location.provider);
  const physicalName = newStorageId();
  const destination = buildOriginalKey({
    organizationId: target.folder.organizationId,
    departmentId: target.folder.departmentId,
    fileId: newFileId,
    versionId: physicalName,
  });

  // Copied within the source's own storage, so the copy of a Drive-backed file is another
  // Drive object. Cross-provider copying is not something a user action should trigger.
  //
  // The destination's Drive folder is prepared first. Without an `externalParentId` a Drive
  // copy lands at the top of the Shared Drive rather than beside the file the user copied
  // it next to — the record would be right and the Drive tree quietly wrong.
  const driveParentId =
    location.provider === 'google_drive' ? await ensureDriveParentFor(target.folder.id) : undefined;

  const stored = await storage.copy(location, {
    key: destination.key,
    area: destination.area,
    ...(driveParentId ? { externalParentId: driveParentId } : {}),
    displayName: sourceVersion.originalFilename,
    contentType: sourceVersion.mimeType,
  });

  try {
    const created = await withTransaction(async (session) => {
      const file = await fileRepository.create(
        {
          id: newFileId,
          organizationId: target.folder.organizationId,
          displayName,
          originalFilename: context.file.originalFilename,
          extension: context.file.extension,
          category: context.file.category,
          folderId: target.folder.id,
          folderPathAncestors: [...target.folder.pathAncestors, target.folder.id],
          driveType: target.folder.driveType,
          ownerId: target.folder.driveType === 'my' ? target.folder.ownerId : actor.userId,
          departmentId: target.folder.departmentId,
          projectId: target.folder.projectId,
          confidentiality: context.file.confidentiality,
          sizeBytes: sourceVersion.fileSize,
          mimeType: sourceVersion.mimeType,
          checksumSha256: sourceVersion.checksumSha256,
          tags: context.file.tags,
          createdBy: actor.userId,
        },
        session,
      );

      const version = await versionRepository.create(
        {
          organizationId: target.folder.organizationId,
          fileId: file.id,
          versionNumber: 1,
          storageKey: destination.key,
          storageArea: destination.area,
          relativeStoragePath: `${destination.area}/${destination.key}`,
          storedFilename: physicalName,
          originalFilename: sourceVersion.originalFilename,
          fileSize: sourceVersion.fileSize,
          mimeType: sourceVersion.mimeType,
          extension: sourceVersion.extension,
          checksumSha256: sourceVersion.checksumSha256,
          uploadedBy: actor.userId,
          versionNote: `Copied from "${context.file.displayName}"`,
          // A Drive-to-Drive copy created its object in Drive and wrote nothing locally.
          // Recording only the local key would leave this version pointing at a path that
          // was never written — present in every listing, and empty on download.
          ...(stored.provider === 'google_drive' && stored.externalId
            ? {
                storageProvider: 'google_drive' as const,
                googleDriveFileId: stored.externalId,
                googleDriveParentId: stored.externalParentId ?? null,
                googleDriveRevisionId: stored.externalRevisionId ?? null,
                googleDriveMd5: stored.checksumMd5 ?? null,
                googleDriveWebViewLink: stored.externalWebViewLink ?? null,
              }
            : {}),
        },
        session,
      );

      await fileRepository.updateById(
        file.id,
        { currentVersionId: version.id, versionCountDelta: 1 },
        session,
      );
      await folderRepository.updateById(target.folder.id, { fileCountDelta: 1 }, session);
      await usageRepository.applyDelta(
        {
          userId: file.ownerId,
          departmentId: target.folder.departmentId,
          projectId: target.folder.projectId,
          bytes: sourceVersion.fileSize,
        },
        session,
      );

      return file;
    });

    await record(actor, meta, created, 'file.copy', {
      previousValue: { sourceFileId: context.file.id },
      newValue: { displayName, folderId: target.folder.id },
    });

    return created;
  } catch (error) {
    await storage
      .remove({
        provider: location.provider,
        key: destination.key,
        area: destination.area,
        ...(stored.externalId ? { externalId: stored.externalId } : {}),
      })
      .catch(() => undefined);
    throw error;
  }
}

export interface UpdateFileInput {
  tags?: string[];
  confidentiality?: ConfidentialityLevel;
  category?: FileCategory;
  projectId?: string | null;
  experimentId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function updateFile(
  actor: Actor,
  fileId: string,
  input: UpdateFileInput,
  meta: RequestMeta,
): Promise<FileView> {
  const context = await requireFile(actor, fileId, 'metadata.edit');
  assertNotApproved(context, 'edited');

  const update: FilePatch = { updatedBy: actor.userId };

  if (input.tags !== undefined) {
    // Deduplicated case-insensitively: "qPCR" and "qpcr" as separate tags would split
    // every search that used either.
    const seen = new Map<string, string>();
    for (const tag of input.tags) {
      const key = tag.trim().toLowerCase();
      if (key && !seen.has(key)) seen.set(key, tag.trim());
    }
    update.tags = [...seen.values()];
  }
  if (input.category !== undefined) update.category = input.category;

  if (input.confidentiality !== undefined) {
    assertMayClassify(actor, context, input.confidentiality);
    update.confidentiality = input.confidentiality;
  }

  if (input.projectId !== undefined) {
    if (input.projectId === null) {
      update.projectId = null;
    } else {
      // Linking a file into a project grants that project's members a route to it, so
      // the actor must be able to reach the project themselves.
      const project = await projectRepository.findById(input.projectId);
      if (!project || project.organizationId !== actor.organizationId) throw new NotFoundError();
      if (
        !actor.isSuperAdmin &&
        !actor.projectIds.includes(project.id) &&
        project.leadUserId !== actor.userId
      ) {
        throw new ForbiddenError('You can only link files to projects you are a member of');
      }
      update.projectId = project.id;
    }
  }

  // Traceability: a file points at the experiment that produced it. The experiment
  // service resolves the link and refuses it unless the actor works on the experiment's
  // project — otherwise linking would be a way to attach company research to a project
  // the actor has no part in, and the project dashboard would then count it.
  let experimentDelta: { from: string | null; to: string | null } | null = null;
  if (input.experimentId !== undefined && input.experimentId !== context.file.experimentId) {
    if (input.experimentId === null) {
      update.experimentId = null;
    } else {
      const experiment = await experimentService.resolveForLinking(actor, input.experimentId);
      update.experimentId = experiment.id;
      // A file linked to an experiment belongs to that experiment's project. Setting it
      // here keeps "trace this file to a project" true even when the file was uploaded
      // somewhere generic; an explicit projectId in the same request still wins.
      if (input.projectId === undefined && !context.file.projectId) {
        update.projectId = experiment.projectId;
      }
    }
    experimentDelta = { from: context.file.experimentId, to: input.experimentId };
  }

  if (input.metadata !== undefined) {
    // Keys are checked against the research-metadata allow-list, so nothing
    // caller-controlled reaches a dotted path or a `$`-prefixed key in the document.
    const { set, unset: cleared } = validateResearchMetadata(input.metadata);
    update.metadataSet = set;
    if (cleared.length > 0) update.metadataUnset = [...cleared];
  }

  const updated = await fileRepository.updateById(fileId, update);
  if (!updated) throw new NotFoundError();

  // Counters are adjusted after the file row is written, and failure to adjust one is not
  // allowed to fail the edit: a dashboard tile that is one out is a cosmetic defect,
  // a rejected metadata edit is lost research annotation.
  if (experimentDelta) {
    if (experimentDelta.from) {
      await experimentService.adjustFileCount(experimentDelta.from, -1).catch(() => undefined);
    }
    if (experimentDelta.to) {
      await experimentService.adjustFileCount(experimentDelta.to, 1).catch(() => undefined);
    }
  }

  await record(actor, meta, updated, 'file.metadata_updated', {
    previousValue: {
      tags: context.file.tags,
      confidentiality: context.file.confidentiality,
      experimentId: context.file.experimentId,
      metadata: context.file.metadata,
    },
    newValue: update,
  });

  return toView({ ...context, file: updated }, actor, false);
}

/** Why a file was surfaced as related. Ordered strongest → weakest. */
export type RelationReason = 'duplicate' | 'experiment' | 'sample' | 'experiment_code';

export interface RelatedFile {
  file: FileView;
  reasons: RelationReason[];
}

/**
 * Files connected to this one.
 *
 * Duplicate detection is the reason this exists. Two copies of the same bytes in two
 * folders is the single most common complaint in the brief, and a checksum match is the
 * only way to state it without guessing: identical content, whatever either copy is
 * called.
 *
 * Results pass the same two-stage visibility check search uses — the query is filtered,
 * then every row is re-checked — because a related-files panel is a search by another
 * name and leaks the same way if it forgets.
 */
export async function listRelated(
  actor: Actor,
  fileId: string,
  limit = 20,
): Promise<RelatedFile[]> {
  const context = await requireFile(actor, fileId, 'file.view');
  const file = context.file;

  const sampleId = typeof file.metadata.sampleId === 'string' ? file.metadata.sampleId : null;
  const experimentCode =
    typeof file.metadata.experimentCode === 'string' ? file.metadata.experimentCode : null;

  const candidates = await fileRepository.findRelated({
    actor,
    excludeFileId: fileId,
    experimentId: file.experimentId,
    sampleId,
    experimentCode,
    checksumSha256: file.checksumSha256,
    // Over-fetched: the second permission pass below removes rows, and a related panel
    // that silently returns four of twenty is worse than one that returns what it found.
    limit: limit * 3,
  });

  const starred = await starRepository.starredIdsAmong(
    actor.userId,
    'file',
    candidates.map((candidate) => candidate.id),
  );

  const related: RelatedFile[] = [];
  for (const candidate of candidates) {
    if (!can(actor, 'file.view', fileResource(candidate))) continue;

    const reasons: RelationReason[] = [];
    if (file.checksumSha256 && candidate.checksumSha256 === file.checksumSha256) {
      reasons.push('duplicate');
    }
    if (file.experimentId && candidate.experimentId === file.experimentId) reasons.push('experiment');
    if (sampleId && candidate.metadata.sampleId === sampleId) reasons.push('sample');
    if (experimentCode && candidate.metadata.experimentCode === experimentCode) {
      reasons.push('experiment_code');
    }
    if (reasons.length === 0) continue;

    related.push({
      file: toView(
        { file: candidate, folderChain: [], ancestorAcls: [] },
        actor,
        starred.has(candidate.id),
      ),
      reasons,
    });
    if (related.length >= limit) break;
  }

  // Duplicates first: they are the actionable finding, the rest are context.
  return related.sort((a, b) => rank(a.reasons) - rank(b.reasons));
}

function rank(reasons: RelationReason[]): number {
  if (reasons.includes('duplicate')) return 0;
  if (reasons.includes('experiment')) return 1;
  if (reasons.includes('sample')) return 2;
  return 3;
}

export async function trashFile(
  actor: Actor,
  fileId: string,
  meta: RequestMeta,
): Promise<void> {
  const context = await requireFile(actor, fileId, 'resource.delete');
  assertNotApproved(context, 'deleted');

  const mirror = await planFileTrash(fileId, true);

  await withDriveMirror({
    describe: `trash file ${fileId}`,
    apply: mirror.apply,
    revert: mirror.revert,
    commit: () =>
      withTransaction(async (session) => {
        await fileRepository.setDeleted({ fileId, deleted: true, userId: actor.userId }, session);
        await folderRepository.updateById(context.file.folderId, { fileCountDelta: -1 }, session);
      }),
  });

  await record(actor, meta, context.file, 'resource.delete', {
    newValue: { retentionDays: getEnv().TRASH_RETENTION_DAYS },
    severity: 'warning',
  });
}

/**
 * The Drive half of trashing or restoring a file.
 *
 * Drive's own trash, not a delete — the bytes stay recoverable there for the same reason
 * they stay recoverable here, and a restore is the exact inverse.
 */
async function planFileTrash(
  fileId: string,
  trashed: boolean,
): Promise<{ apply: () => Promise<void>; revert: () => Promise<void> }> {
  const hierarchy = driveHierarchy();
  if (!hierarchy) return NO_MIRROR;

  const externalIds = await driveObjectsForFile(fileId);
  if (externalIds.length === 0) return NO_MIRROR;
  assertMirrorableCount(externalIds.length);

  return mirrorTrash({ hierarchy, externalIds, trashed });
}

export async function restoreFile(
  actor: Actor,
  fileId: string,
  meta: RequestMeta,
): Promise<FileView> {
  const context = await requireFile(actor, fileId, 'resource.restore', { includeDeleted: true });
  if (!context.file.deletedAt) return toView(context, actor, false);

  // Internal: whether the containing folder is still in the trash does not depend on who
  // is asking — a folder the actor may not view can still be why their restore has to wait.
  const folder = await folderRepository.findByIdInternal(context.file.folderId, {
    includeDeleted: true,
  });
  if (!folder) throw new ConflictError('The folder this file was in no longer exists');
  if (folder.deletedAt) {
    throw new ConflictError(`Restore the folder "${folder.name}" first — this file was inside it`);
  }
  if (await fileRepository.existsWithName(context.file.folderId, context.file.displayName.toLowerCase(), fileId)) {
    throw new ConflictError(
      `A file named "${context.file.displayName}" was created here after this one was deleted. Rename one of them first.`,
    );
  }

  const mirror = await planFileTrash(fileId, false);

  await withDriveMirror({
    describe: `restore file ${fileId}`,
    apply: mirror.apply,
    revert: mirror.revert,
    commit: () =>
      withTransaction(async (session) => {
        await fileRepository.setDeleted({ fileId, deleted: false, userId: actor.userId }, session);
        await folderRepository.updateById(context.file.folderId, { fileCountDelta: 1 }, session);
      }),
  });

  // Internal: re-reading the row this request just restored, whose permission was
  // asserted at the top of the request.
  const restored = await fileRepository.findByIdInternal(fileId);
  if (!restored) throw new NotFoundError();

  await record(actor, meta, restored, 'resource.restore', { severity: 'notice' });
  return toView({ ...context, file: restored }, actor, false);
}

export async function setStarred(
  actor: Actor,
  fileId: string,
  starred: boolean,
): Promise<{ isStarred: boolean }> {
  await requireFile(actor, fileId, 'file.view');
  if (starred) {
    await starRepository.add({
      userId: actor.userId,
      organizationId: actor.organizationId,
      entityType: 'file',
      entityId: fileId,
    });
  } else {
    await starRepository.remove({ userId: actor.userId, entityType: 'file', entityId: fileId });
  }
  return { isStarred: starred };
}

export async function listStarred(actor: Actor): Promise<FileView[]> {
  const stars = await starRepository.listForUser(actor.userId, { entityType: 'file' });
  return resolveMany(actor, stars.map((star) => star.entityId));
}

export async function listRecent(actor: Actor): Promise<FileView[]> {
  const recent = await recentRepository.listForUser(actor.userId, { entityType: 'file' });
  return resolveMany(actor, recent.map((entry) => entry.entityId));
}

export async function listTrash(
  actor: Actor,
  input: { page: number; pageSize: number },
): Promise<{ items: FileView[]; total: number }> {
  const { items, total } = await fileRepository.listTrashed({
    actor,
    page: input.page,
    pageSize: input.pageSize,
  });

  const views = await Promise.all(
    items.map(async (item) => {
      const context = await loadFileContext(actor, item.id, { includeDeleted: true });
      return context ? toView(context, actor, false) : null;
    }),
  );

  return { items: views.filter((view): view is FileView => view !== null), total };
}

/**
 * Permanently deletes files past the retention window, bytes first.
 *
 * The version rows are the only pointers to the stored objects, so they are read before
 * anything is removed; a crash between the two leaves orphaned bytes that the storage
 * verification script reports, which is far better than a metadata row pointing at a
 * file that is gone.
 */
export async function purgeExpiredTrash(): Promise<{ files: number; bytes: number }> {
  const env = getEnv();
  const cutoff = new Date(Date.now() - env.TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await fileRepository.findExpiredTrashInternal(cutoff);
  if (expired.length === 0) return { files: 0, bytes: 0 };

  const ids = expired.map((file) => file.id);
  const locations = await versionRepository.getStorageLocationsForFiles(ids);

  let bytes = 0;
  for (const file of expired) {
    bytes += file.sizeBytes;
    await usageRepository.applyDelta({
      userId: file.ownerId,
      departmentId: file.departmentId,
      projectId: file.projectId,
      bytes: -file.sizeBytes,
    });
  }

  // Resolved per record: a purge batch can span both providers while the migration is in
  // progress, and a version that has moved to Drive must not be deleted by local key.
  for (const location of locations) {
    await getObjectStore(location.provider)
      .remove(location)
      .catch(() => undefined);
  }

  await versionRepository.purgeForFiles(ids);
  await starRepository.removeAllFor('file', ids);
  await recentRepository.removeAllFor('file', ids);
  // Comments and notifications must not outlive their subject: a notification pointing
  // at a purged id is a dangling reference to a filename the recipient can no longer
  // verify, and a comment thread about a file nobody can open is just a leak of what the
  // file contained.
  await commentRepository.purgeForFiles(ids);
  await notificationRepository.purgeForEntities(ids);
  await reviewRepository.purgeForFiles(ids);
  const files = await fileRepository.purge(ids);

  return { files, bytes };
}

/* --------------------------------------------------------------- helpers */

async function resolveMany(actor: Actor, ids: string[]): Promise<FileView[]> {
  const contexts = await Promise.all(ids.map((id) => loadFileContext(actor, id)));
  const starred = await starRepository.starredIdsAmong(actor.userId, 'file', ids);
  const views: FileView[] = [];

  for (const context of contexts) {
    if (!context) continue;
    if (!can(actor, 'file.view', fileResource(context.file), { ancestorAcls: context.ancestorAcls })) {
      continue;
    }
    views.push(toView(context, actor, starred.has(context.file.id)));
  }
  return views;
}

async function totalVersionBytes(fileId: string): Promise<number> {
  const versions = await versionRepository.listForFile(fileId);
  return versions.reduce((sum, version) => sum + version.fileSize, 0);
}

async function assertRoomFor(
  actor: Actor,
  departmentId: string | null,
  bytes: number,
): Promise<void> {
  const userQuota = await usageRepository.getUserQuota(actor.userId);
  if (userQuota && userQuota.remainingBytes < bytes) {
    throw new ConflictError('That copy would exceed your storage quota', 'QUOTA_EXCEEDED');
  }
  if (departmentId) {
    const departmentQuota = await usageRepository.getDepartmentQuota(departmentId);
    if (departmentQuota && departmentQuota.remainingBytes < bytes) {
      throw new ConflictError('That copy would exceed the department storage quota', 'QUOTA_EXCEEDED');
    }
  }
}

/**
 * Guards a change of classification.
 *
 * The two directions are not symmetrical, and only one of them is dangerous:
 *
 *  • **Upward** is unrestricted. Raising a file to `confidential` or `restricted` only
 *    ever *removes* reach — it grants the actor nothing they did not already have, and
 *    it is the correct reflex when someone realizes a file is more sensitive than its
 *    folder implied. Requiring clearance to do it would mean a scientist who spots
 *    unblinded patient data in a shared folder cannot lock it down, which is precisely
 *    backwards. If they classify it beyond their own reach, they lose it — their choice,
 *    and it is audited.
 *
 *  • **Downward is a disclosure.** Dropping `confidential` to `internal` hands the file
 *    to every colleague with department scope in a single request, with no share, no
 *    notification and no obvious trace in the UI. That needs `access.manage` — the same
 *    permission that governs sharing, because it is the same act — and the audit record
 *    carries both the old and the new value.
 */
function assertMayClassify(
  actor: Actor,
  context: FileContext,
  next: ConfidentialityLevel,
): void {
  const current = context.file.confidentiality;
  if (current === next) return;
  if (actor.isSuperAdmin) return;

  const isDowngrade = CONFIDENTIALITY_RANK[next] < CONFIDENTIALITY_RANK[current];
  if (!isDowngrade) return;

  if (!fileCan(actor, 'access.manage', context)) {
    throw new ForbiddenError(
      'Lowering a file’s confidentiality requires permission to manage its access',
    );
  }

  // A downgrade must also land somewhere the actor can actually see, otherwise it is a
  // blind change to a classification whose consequences they cannot observe.
  if (CONFIDENTIALITY_RANK[current] > CONFIDENTIALITY_RANK[actorClearance(actor)]) {
    throw new ForbiddenError(
      'You cannot declassify a file that is above your own clearance level',
    );
  }
}

/**
 * An approved file is read-only. Changing it is not forbidden — it is a new version,
 * which is a different action and leaves the approved one intact.
 */
function assertNotApproved(context: FileContext, verb: string): void {
  if (context.file.approvalStatus === 'approved') {
    throw new ForbiddenError(
      `This file is approved and cannot be ${verb}. Upload a new version instead — the approved version stays available.`,
    );
  }
}

function toView(context: FileContext, actor: Actor, isStarred: boolean): FileView {
  return {
    ...context.file,
    isStarred,
    previewable: isPreviewable(context.file.extension),
    capabilities: fileCapabilities(actor, context),
  };
}

async function record(
  actor: Actor,
  meta: RequestMeta,
  file: FileRecord,
  action: AuditAction,
  extra: {
    previousValue?: unknown;
    newValue?: unknown;
    severity?: 'info' | 'notice' | 'warning' | 'critical';
  } = {},
): Promise<void> {
  await auditService.recordForActor(actor, meta, {
    action,
    entityType: 'file',
    entityId: file.id,
    entityLabel: file.displayName,
    ...extra,
  });

  void activityRepository
    .append({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorName: actor.name,
      action,
      entityType: 'file',
      entityId: file.id,
      entityLabel: file.displayName,
      contextFolderIds: file.folderPathAncestors,
      departmentId: file.departmentId,
      projectId: file.projectId,
    })
    .catch(() => undefined);
}

export const fileService = {
  getFile,
  listInFolder,
  listVersions,
  renameFile,
  moveFile,
  copyFile,
  copyFilesForFolderCopy,
  updateFile,
  trashFile,
  restoreFile,
  setStarred,
  listStarred,
  listRecent,
  listTrash,
  listRelated,
  purgeExpiredTrash,
};
