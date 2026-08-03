/**
 * Moving one version's bytes into the Shared Drive.
 *
 * This is the module where losing data is possible, so it is written around the four
 * independent duplicate-prevention layers from §7.4 of the Phase 0 analysis. They are
 * independent on purpose — each one covers a failure the others cannot see:
 *
 *   1. **Atomic claim** (`claimNextItem`) — two workers cannot hold the same item.
 *   2. **Unique index** on `FileVersion.googleDriveFileId` — the database refuses to record
 *      a second Drive file for one version, even if every layer above it has failed.
 *   3. **Pre-flight adoption** — a version that already has a Drive id is checked, not
 *      re-uploaded. Covers a retry after a response was lost in transit.
 *   4. **`appProperties.idempotencyKey`** — covers the genuinely hard case: the process died
 *      *after* Drive committed and *before* MongoDB did, so nothing in the database points
 *      at the object. The recovery row says which key to search Drive for.
 *
 * And the ordering rule that makes layer 4 work: **the recovery row is written before the
 * Drive call, and cleared after the MongoDB commit.** Anything still open is, by
 * construction, an operation that got part-way.
 *
 * The local copy is never touched. Not moved, not deleted, not modified. Deleting it is a
 * separate, explicitly-approved admin action in Phase 11, and until then it is the whole of
 * the rollback plan.
 */
import { createHash } from 'crypto';
import { Types } from 'mongoose';

import { connectToDatabase } from '@/server/db/connection';
import { FileModel } from '@/server/db/models/file.model';
import { FileVersionModel } from '@/server/db/models/file-version.model';
import { getEnv } from '@/server/config/env';
import { getLogger } from '@/server/logging/logger';
import { getObjectStore, getStorageProvider } from '@/server/storage';
import { isWritableObjectStore, type StorageArea, type WritableObjectStore } from '@/server/storage/types';
import { escapeDriveQueryValue, type DriveClient } from '@/server/storage/google/drive-client';
import { isMissingObjectError } from '@/server/storage/missing-object';
import * as migrationRepository from '@/server/repositories/storage-migration.repository';
import type { ItemRecord } from '@/server/repositories/storage-migration.repository';
import type { StorageMigrationFailureCode } from '@/server/db/models/storage-migration-item.model';
import { ensureDriveFolderPath } from './folder-mirror';

export interface TransferOutcome {
  status: 'verified' | 'skipped' | 'failed';
  code?: StorageMigrationFailureCode;
  detail?: string;
  bytes: number;
  driveFileId?: string;
  /** Measured off local disk during the transfer; recorded on the migration item. */
  localSha256?: string;
  localMd5?: string;
  /** Google's own digest, which is what proves the round trip. */
  remoteMd5?: string;
}

export interface TransferDeps {
  /** The Drive store, for the upload. */
  store: WritableObjectStore;
  /** The raw client, only for the orphan search in layer 4. */
  client: DriveClient;
  /** Folder mirroring. Same object as `store` in production. */
  hierarchy: Parameters<typeof ensureDriveFolderPath>[0]['hierarchy'];
}

interface VersionSnapshot {
  id: string;
  fileId: string;
  storageKey: string;
  storageArea: StorageArea;
  fileSize: number;
  mimeType: string;
  checksumSha256: string;
  originalFilename: string;
  storageProvider: string;
  googleDriveFileId: string | null;
  migrationStatus: string;
}

async function loadVersion(versionId: string): Promise<VersionSnapshot | null> {
  await connectToDatabase();
  const doc = await FileVersionModel.findById(new Types.ObjectId(versionId))
    .select({
      fileId: 1,
      storageKey: 1,
      storageArea: 1,
      fileSize: 1,
      mimeType: 1,
      checksumSha256: 1,
      originalFilename: 1,
      storageProvider: 1,
      googleDriveFileId: 1,
      migrationStatus: 1,
    })
    .lean<{
      _id: Types.ObjectId;
      fileId: Types.ObjectId;
      storageKey: string;
      storageArea: string;
      fileSize: number;
      mimeType: string;
      checksumSha256: string;
      originalFilename: string;
      storageProvider?: string;
      googleDriveFileId?: string | null;
      migrationStatus?: string;
    }>()
    .exec();

  if (!doc) return null;
  return {
    id: String(doc._id),
    fileId: String(doc.fileId),
    storageKey: doc.storageKey,
    storageArea: doc.storageArea as StorageArea,
    fileSize: doc.fileSize,
    mimeType: doc.mimeType,
    checksumSha256: doc.checksumSha256,
    originalFilename: doc.originalFilename,
    storageProvider: doc.storageProvider ?? 'local',
    googleDriveFileId: doc.googleDriveFileId ?? null,
    migrationStatus: doc.migrationStatus ?? 'not_started',
  };
}

/**
 * Hashes the local file, in one pass, before anything is uploaded.
 *
 * Two digests from the same read:
 *   • **SHA-256** is compared against what MongoDB recorded at upload time. A mismatch is
 *     local bit-rot, and the whole point of checking here rather than after the transfer is
 *     that corrupt bytes must never reach company storage in the first place.
 *   • **MD5** is what Drive publishes, so it is what the round trip can be verified against
 *     later without re-downloading the object.
 *
 * This costs a second read of the file — once to hash, once to upload. Accepted
 * deliberately: it is local disk, it is sequential, and the alternative is discovering
 * corruption only after it has been propagated.
 */
async function hashLocalCopy(
  key: string,
  area: StorageArea,
): Promise<{ sha256: string; md5: string; bytes: number }> {
  const stream = await getStorageProvider().getFile(key, area);
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let bytes = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    sha256.update(buffer);
    md5.update(buffer);
    bytes += buffer.length;
  }

  return { sha256: sha256.digest('hex'), md5: md5.digest('hex'), bytes };
}

/**
 * Layer 4: find an object this job already created but never managed to record.
 *
 * Searched by our own stamped key, scoped to the configured Shared Drive by the client.
 * Without this, a crash between the Drive commit and the MongoDB commit leaves an orphan
 * that the retry cannot see — so it uploads again, and company storage accumulates a
 * duplicate for every crash.
 */
async function findOrphanByIdempotencyKey(
  client: DriveClient,
  idempotencyKey: string,
): Promise<string | null> {
  const query = [
    `appProperties has { key='idempotencyKey' and value='${escapeDriveQueryValue(idempotencyKey)}' }`,
    'trashed = false',
  ].join(' and ');

  const page = await client.listFiles({ query, pageSize: 2 });
  return page.files[0]?.id ?? null;
}

/** Confirms an object we believe exists really does, and matches what we expect. */
async function verifyRemote(
  client: DriveClient,
  driveFileId: string,
  expected: { size: number; md5: string | null },
): Promise<{ ok: boolean; remoteMd5: string | null; detail?: string }> {
  const remote = await client.getFile(driveFileId);

  const remoteSize = remote.size !== undefined ? Number(remote.size) : null;
  if (remoteSize !== null && remoteSize !== expected.size) {
    return {
      ok: false,
      remoteMd5: remote.md5Checksum ?? null,
      detail: `Google Drive holds ${remoteSize} bytes, expected ${expected.size}`,
    };
  }

  if (!remote.md5Checksum) {
    return { ok: false, remoteMd5: null, detail: 'Google Drive reported no checksum for the object' };
  }

  if (expected.md5 && remote.md5Checksum.toLowerCase() !== expected.md5.toLowerCase()) {
    return {
      ok: false,
      remoteMd5: remote.md5Checksum,
      detail: 'The object in Google Drive does not match the local file',
    };
  }

  return { ok: true, remoteMd5: remote.md5Checksum };
}

/**
 * Commits the migration for one version.
 *
 * **`storageKey` is not touched.** After this the version carries both addresses, which is
 * exactly what makes a rollback a single field change with no data movement.
 */
async function recordMigrated(input: {
  versionId: string;
  fileId: string;
  driveFileId: string;
  driveParentId: string;
  revisionId: string | null;
  webViewLink: string | null;
  md5: string;
}): Promise<void> {
  const retentionDays = getEnv().LOCAL_COPY_RETENTION_DAYS;

  await FileVersionModel.updateOne(
    { _id: new Types.ObjectId(input.versionId) },
    {
      $set: {
        storageProvider: 'google_drive',
        googleDriveFileId: input.driveFileId,
        googleDriveParentId: input.driveParentId,
        googleDriveRevisionId: input.revisionId,
        googleDriveWebViewLink: input.webViewLink,
        googleDriveMd5: input.md5,
        migrationStatus: 'verified',
        migratedAt: new Date(),
        migrationFailureReason: null,
        syncStatus: 'synced',
        lastSyncedAt: new Date(),
        localCopyState: 'present',
        localCopyEligibleForDeletionAt: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000),
      },
    },
  ).exec();

  await refreshFileStorageMirror(input.fileId);
}

/**
 * Keeps `File.storageProvider` honest.
 *
 * Read-only mirror used by listings and the admin dashboard. `mixed` is the real state of a
 * file whose v1 is still local and whose v2 has moved, and it is the state most files are in
 * for the duration of a migration.
 */
export async function refreshFileStorageMirror(fileId: string): Promise<void> {
  await connectToDatabase();
  const counts = await FileVersionModel.aggregate<{ _id: string | null; count: number }>([
    { $match: { fileId: new Types.ObjectId(fileId) } },
    { $group: { _id: '$storageProvider', count: { $sum: 1 } } },
  ]).exec();

  let drive = 0;
  let local = 0;
  for (const row of counts) {
    if (row._id === 'google_drive') drive += row.count;
    else local += row.count;
  }

  const provider = drive === 0 ? 'local' : local === 0 ? 'google_drive' : 'mixed';
  await FileModel.updateOne(
    { _id: new Types.ObjectId(fileId) },
    { $set: { storageProvider: provider } },
    { withDeleted: true } as never,
  ).exec();
}

/**
 * One version's worth of work, independent of who asked for it.
 *
 * Split out from `transferItem` so a *newly uploaded* file can reach Drive through exactly
 * the same code as a migrated one — same verification, same four duplicate-prevention
 * layers, same recovery-row ordering. An upload path with its own parallel transfer
 * implementation would be a second place for all of that to be subtly wrong.
 */
export interface TransferTarget {
  versionId: string;
  fileId: string;
  folderId: string;
  displayName: string;
  organizationId: string;
  /** Stable across retries: it identifies the work, not the attempt. */
  idempotencyKey: string;
  /** Absent when the transfer came from an upload rather than a migration job. */
  jobId?: string | null;
}

export async function transferItem(item: ItemRecord, deps: TransferDeps): Promise<TransferOutcome> {
  const startedAt = Date.now();
  const outcome = await transferVersion(
    {
      versionId: item.versionId,
      fileId: item.fileId,
      folderId: item.folderId,
      displayName: item.displayName,
      organizationId: item.organizationId,
      idempotencyKey: item.idempotencyKey,
      jobId: item.jobId,
    },
    deps,
  );

  if (outcome.status === 'verified' && outcome.driveFileId) {
    await migrationRepository.completeItem({
      itemId: item.id,
      googleDriveFileId: outcome.driveFileId,
      localSha256: outcome.localSha256 ?? '',
      localMd5: outcome.localMd5 ?? '',
      remoteMd5: outcome.remoteMd5 ?? outcome.localMd5 ?? '',
      transferMs: Date.now() - startedAt,
    });
  }

  return outcome;
}

export async function transferVersion(
  item: TransferTarget,
  deps: TransferDeps,
): Promise<TransferOutcome> {
  const log = getLogger().child({ jobId: item.jobId ?? null, versionId: item.versionId });

  const version = await loadVersion(item.versionId);
  if (!version) {
    return { status: 'failed', code: 'LOCAL_MISSING', detail: 'The version no longer exists', bytes: 0 };
  }

  /* ── Layer 3: already migrated? Check, never re-upload. ─────────────────────── */
  if (version.storageProvider === 'google_drive' && version.googleDriveFileId) {
    try {
      const check = await verifyRemote(deps.client, version.googleDriveFileId, {
        size: version.fileSize,
        md5: null,
      });
      if (check.ok) {
        log.info('Version is already in Drive and verifies; skipping the transfer');
        return {
          status: 'skipped',
          bytes: version.fileSize,
          driveFileId: version.googleDriveFileId,
        };
      }
    } catch (error) {
      if (!isMissingObjectError(error)) throw error;
      // Recorded as migrated but the object is gone. Falls through and re-uploads from the
      // retained local copy, which is the only reason that is possible.
      log.warn('Recorded as migrated but the Drive object is missing; re-uploading from the local copy');
    }
  }

  /* ── Read and validate the local bytes before anything leaves this server. ──── */
  let local: { sha256: string; md5: string; bytes: number };
  try {
    local = await hashLocalCopy(version.storageKey, version.storageArea);
  } catch (error) {
    return {
      status: 'failed',
      code: 'LOCAL_MISSING',
      detail: isMissingObjectError(error)
        ? 'The local file is missing from this server'
        : 'The local file could not be read',
      bytes: 0,
    };
  }

  if (local.bytes !== version.fileSize) {
    return {
      status: 'failed',
      code: 'LOCAL_CORRUPT',
      detail: `The local file is ${local.bytes} bytes but the database records ${version.fileSize}`,
      bytes: 0,
    };
  }

  if (local.sha256 !== version.checksumSha256) {
    // Local bit-rot. Refusing here is the point: propagating corruption into company
    // storage and then verifying the corrupt copy against itself would record it as good.
    return {
      status: 'failed',
      code: 'LOCAL_CORRUPT',
      detail: 'The local file no longer matches the checksum recorded when it was uploaded',
      bytes: 0,
    };
  }

  /* ── Destination folder. Created lazily, walking root → leaf. ───────────────── */
  let parentExternalId: string;
  try {
    const mirror = await ensureDriveFolderPath({ folderId: item.folderId, hierarchy: deps.hierarchy });
    parentExternalId = mirror.externalId;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'The destination folder could not be created';
    return {
      status: 'failed',
      code: detail.includes('levels deep') ? 'FOLDER_TOO_DEEP' : 'FOLDER_MAPPING_FAILED',
      detail,
      bytes: 0,
    };
  }

  /* ── Layer 4 setup: the recovery row goes in BEFORE the Drive call. ─────────── */
  await migrationRepository.openRecovery({
    organizationId: item.organizationId,
    versionId: item.versionId,
    jobId: item.jobId,
    idempotencyKey: item.idempotencyKey,
    phase: 'drive_write_pending',
  });

  // ...and before uploading, check whether a previous crash already left one there.
  let driveFileId: string | null = null;
  try {
    driveFileId = await findOrphanByIdempotencyKey(deps.client, item.idempotencyKey);
    if (driveFileId) {
      log.warn({ driveFileId }, 'Adopting an object left in Drive by an interrupted run');
    }
  } catch (error) {
    log.warn({ err: error }, 'Could not search Drive for an orphaned object; continuing');
  }

  let parentId = parentExternalId;
  let revisionId: string | null = null;
  let webViewLink: string | null = null;
  let remoteMd5: string | null = null;

  if (!driveFileId) {
    const body = await getStorageProvider().getFile(version.storageKey, version.storageArea);

    try {
      const stored = await deps.store.put({
        target: {
          key: version.storageKey,
          area: version.storageArea,
          externalParentId: parentExternalId,
          displayName: item.displayName || version.originalFilename,
          contentType: version.mimeType,
        },
        body,
        size: version.fileSize,
        // The store compares this against what it hashes on the way past *and* against
        // Drive's own checksum, and deletes the remote object if either disagrees.
        expectedMd5: local.md5,
        properties: { idempotencyKey: item.idempotencyKey },
      });

      driveFileId = stored.externalId ?? null;
      parentId = stored.externalParentId ?? parentExternalId;
      revisionId = stored.externalRevisionId ?? null;
      webViewLink = stored.externalWebViewLink ?? null;
      remoteMd5 = stored.checksumMd5 ?? null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The upload failed';
      await migrationRepository.advanceRecovery(item.idempotencyKey, { detail });
      // The recovery row stays open. A later sweep — or the next attempt — searches for the
      // key and adopts anything that did land.
      return { status: 'failed', code: classifyUploadFailure(detail), detail, bytes: 0 };
    }
  }

  if (!driveFileId) {
    return { status: 'failed', code: 'DRIVE_UPLOAD_FAILED', detail: 'No Drive file id was returned', bytes: 0 };
  }

  await migrationRepository.advanceRecovery(item.idempotencyKey, {
    phase: 'database_write_pending',
    observedDriveFileId: driveFileId,
  });

  /* ── Verify the round trip against Drive's own view of the object. ──────────── */
  try {
    const check = await verifyRemote(deps.client, driveFileId, { size: version.fileSize, md5: local.md5 });
    if (!check.ok) {
      // Never leave an unverified object addressable in company storage.
      await deps.client.deleteFile(driveFileId).catch(() => undefined);
      await migrationRepository.closeRecovery(item.idempotencyKey, 'resolved_reverted');
      return {
        status: 'failed',
        code: 'VERIFY_MISMATCH',
        detail: check.detail ?? 'The uploaded object did not verify',
        bytes: 0,
      };
    }
    remoteMd5 = check.remoteMd5 ?? remoteMd5;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Verification failed';
    await migrationRepository.advanceRecovery(item.idempotencyKey, { detail });
    return { status: 'failed', code: 'DRIVE_UPLOAD_FAILED', detail, bytes: 0 };
  }

  /* ── Commit, then close the recovery row. Local copy untouched. ─────────────── */
  try {
    await recordMigrated({
      versionId: item.versionId,
      fileId: item.fileId,
      driveFileId,
      driveParentId: parentId,
      revisionId,
      webViewLink,
      md5: remoteMd5 ?? local.md5,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'The database write failed';
    // Bytes are in Drive; the record is not. The row stays open and names the object, so
    // reconciliation adopts it instead of re-uploading. The user is not told this worked.
    await migrationRepository.advanceRecovery(item.idempotencyKey, { detail });
    log.error({ err: error, driveFileId }, 'Drive object created but the database was not updated');
    return { status: 'failed', code: 'DATABASE_WRITE_FAILED', detail, bytes: 0 };
  }

  await migrationRepository.closeRecovery(item.idempotencyKey, 'resolved_adopted');

  return {
    status: 'verified',
    bytes: version.fileSize,
    driveFileId,
    localSha256: local.sha256,
    localMd5: local.md5,
    remoteMd5: remoteMd5 ?? local.md5,
  };
}

function classifyUploadFailure(detail: string): StorageMigrationFailureCode {
  const text = detail.toLowerCase();
  if (text.includes('quota')) return 'DRIVE_QUOTA_EXCEEDED';
  if (text.includes('rate limit')) return 'DRIVE_RATE_LIMITED';
  if (text.includes('permission') || text.includes('denied')) return 'DRIVE_PERMISSION_DENIED';
  if (text.includes('checksum') || text.includes('did not match')) return 'VERIFY_MISMATCH';
  return 'DRIVE_UPLOAD_FAILED';
}

/** Resolves the Drive store, refusing clearly if this deployment has no Drive configured. */
export function requireDriveStore(): WritableObjectStore {
  const store = getObjectStore('google_drive');
  if (!isWritableObjectStore(store)) {
    throw new Error('The Google Drive storage provider cannot accept uploads on this deployment');
  }
  return store;
}
