/**
 * Version history operations that are not uploads.
 *
 * Restoring an older version is the interesting one, and the rule it obeys is the whole
 * point of the versioning design: **restore never rewinds history**. It reads the old
 * bytes, writes them to a *new* physical key, and appends a new version that records
 * where it came from. Nothing is overwritten, the approved version stays exactly where
 * it was, and "which bytes did the reviewer sign?" remains answerable forever.
 *
 * The alternative — flipping `isCurrent` back to an earlier row — would be cheaper and
 * is what a naive implementation does. It also silently makes the version list a lie,
 * because the file's current content would then have no version of its own.
 */
import { withTransaction } from '@/server/db/connection';
import { ConflictError, NotFoundError } from '@/server/errors/app-error';
import type { Actor } from '@/server/permissions/actor';
import { auditService } from '@/server/audit/audit.service';
import * as activityRepository from '@/server/repositories/activity.repository';
import * as fileRepository from '@/server/repositories/file.repository';
import * as versionRepository from '@/server/repositories/file-version.repository';
import type { VersionRecord } from '@/server/repositories/file-version.repository';
import * as reviewRepository from '@/server/repositories/review.repository';
import * as usageRepository from '@/server/repositories/storage-usage.repository';
import { getObjectStore } from '@/server/storage';
import { buildOriginalKey, newStorageId } from '@/server/storage/keys';
import type { RequestMeta } from '@/server/http/request-meta';
import { requireFile } from './file-access';

export interface RestoreVersionInput {
  versionId: string;
  note?: string;
}

export async function restoreVersion(
  actor: Actor,
  fileId: string,
  input: RestoreVersionInput,
  meta: RequestMeta,
): Promise<VersionRecord> {
  // Restoring produces a new version, so it is authorized as a version upload rather
  // than as an edit. That matters for approved files: `version.upload` is deliberately
  // still available on them, because a new version is the sanctioned way to change one.
  const context = await requireFile(actor, fileId, 'version.upload');

  const source = await versionRepository.findById(input.versionId);
  if (!source || source.fileId !== fileId) throw new NotFoundError();

  if (source.isCurrent) {
    throw new ConflictError('That version is already the current one');
  }

  const location = await versionRepository.getStorageLocation(source.id);
  if (!location) throw new NotFoundError();

  const storage = getObjectStore(location.provider);
  if (!(await storage.exists(location))) {
    // The metadata says the bytes exist and they do not. Surfacing this as a conflict
    // rather than a 500 tells the operator exactly what to run the integrity check on.
    throw new ConflictError(
      'The stored data for that version is missing. Contact an administrator — the storage integrity check will report it.',
      'STORAGE_ERROR',
    );
  }

  // Quota is charged again because the restore genuinely writes another copy. Skipping
  // the check because "it is the same content" would let a user loop restore/upload to
  // grow past their quota without ever uploading anything new.
  await assertRoomFor(actor, context.file.departmentId, source.fileSize);

  const physicalName = newStorageId();
  const destination = buildOriginalKey({
    organizationId: context.file.organizationId,
    departmentId: context.file.departmentId,
    fileId,
    versionId: physicalName,
  });

  // Copied within the source's own storage: restoring a version of a Drive-backed file
  // produces another Drive object, not a local one. The new version therefore inherits
  // `location.provider` rather than the configured default.
  const stored = await storage.copy(location, {
    key: destination.key,
    area: destination.area,
    displayName: source.originalFilename,
    contentType: source.mimeType,
  });

  try {
    const created = await withTransaction(async (dbSession) => {
      const versionNumber = await versionRepository.nextVersionNumber(fileId);

      const version = await versionRepository.create(
        {
          organizationId: context.file.organizationId,
          fileId,
          versionNumber,
          storageKey: destination.key,
          storageArea: destination.area,
          relativeStoragePath: `${destination.area}/${destination.key}`,
          storedFilename: physicalName,
          originalFilename: source.originalFilename,
          fileSize: source.fileSize,
          mimeType: source.mimeType,
          extension: source.extension,
          checksumSha256: source.checksumSha256,
          uploadedBy: actor.userId,
          versionNote:
            input.note?.trim() ||
            `Restored from version ${source.versionNumber}`,
          restoredFromVersionId: source.id,
        },
        dbSession,
      );

      await versionRepository.setCurrent(fileId, version.id, dbSession);

      // Same reasoning as a fresh upload: a review of the previously current bytes is a
      // review of content that is no longer current.
      await reviewRepository.cancelOpenForFile(fileId, undefined, dbSession);

      await fileRepository.updateById(
        fileId,
        {
          currentVersionId: version.id,
          sizeBytes: source.fileSize,
          mimeType: source.mimeType,
          checksumSha256: source.checksumSha256,
          originalFilename: source.originalFilename,
          updatedBy: actor.userId,
          // Same rule as a fresh upload: the file's content changed, so the review
          // cycle restarts. The previously approved version keeps its own flags.
          reviewStatus: 'draft',
          approvalStatus: 'none',
          approvedVersionId: null,
          versionCountDelta: 1,
        },
        dbSession,
      );

      await usageRepository.applyDelta(
        {
          userId: actor.userId,
          departmentId: context.file.departmentId,
          projectId: context.file.projectId,
          bytes: source.fileSize,
        },
        dbSession,
      );

      return version;
    });

    await auditService.recordForActor(actor, meta, {
      action: 'file.version_restore',
      entityType: 'file',
      entityId: fileId,
      entityLabel: context.file.displayName,
      previousValue: { currentVersionId: context.file.currentVersionId },
      newValue: {
        currentVersionId: created.id,
        versionNumber: created.versionNumber,
        restoredFromVersionNumber: source.versionNumber,
      },
      severity: 'notice',
    });

    void activityRepository
      .append({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorName: actor.name,
        action: 'file.version_restore',
        entityType: 'file',
        entityId: fileId,
        entityLabel: context.file.displayName,
        detail: `restored version ${source.versionNumber} as version ${created.versionNumber}`,
        contextFolderIds: context.file.folderPathAncestors,
        departmentId: context.file.departmentId,
        projectId: context.file.projectId,
      })
      .catch(() => undefined);

    return created;
  } catch (error) {
    // The copy landed but the metadata did not. Remove the orphan rather than leave
    // bytes that no document references — the integrity check would flag them forever.
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

/**
 * Version notes are the one mutable field on a stored version (see the immutability
 * hook in `file-version.model.ts`). Correcting a typo in a note is not a change to the
 * data, and forcing a re-upload to fix one would be absurd.
 */
export async function updateVersionNote(
  actor: Actor,
  fileId: string,
  versionId: string,
  note: string,
  meta: RequestMeta,
): Promise<VersionRecord> {
  const context = await requireFile(actor, fileId, 'metadata.edit');

  const version = await versionRepository.findById(versionId);
  if (!version || version.fileId !== fileId) throw new NotFoundError();

  await versionRepository.updateFlags(versionId, { $set: { versionNote: note.trim() } });

  const updated = await versionRepository.findById(versionId);
  if (!updated) throw new NotFoundError();

  await auditService.recordForActor(actor, meta, {
    action: 'file.metadata_updated',
    entityType: 'file_version',
    entityId: versionId,
    entityLabel: `${context.file.displayName} v${version.versionNumber}`,
    previousValue: { versionNote: version.versionNote },
    newValue: { versionNote: updated.versionNote },
  });

  return updated;
}

async function assertRoomFor(
  actor: Actor,
  departmentId: string | null,
  bytes: number,
): Promise<void> {
  const userQuota = await usageRepository.getUserQuota(actor.userId);
  if (userQuota && userQuota.remainingBytes < bytes) {
    throw new ConflictError('Restoring that version would exceed your storage quota', 'QUOTA_EXCEEDED');
  }
  if (departmentId) {
    const departmentQuota = await usageRepository.getDepartmentQuota(departmentId);
    if (departmentQuota && departmentQuota.remainingBytes < bytes) {
      throw new ConflictError(
        'Restoring that version would exceed the department storage quota',
        'QUOTA_EXCEEDED',
      );
    }
  }
}

export const versionService = {
  restoreVersion,
  updateVersionNote,
};
