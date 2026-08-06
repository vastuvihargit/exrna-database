/**
 * Google Drive migration.
 *
 * The controlling requirement is negative and absolute: **the originals are never
 * touched**. That is enforced structurally rather than by policy — the reader this
 * service is given (`DriveReader`) has four methods, all reads, and the live
 * implementation requests only `drive.readonly`. There is no code path from here that
 * can delete, rename or modify anything in Drive, because none exists to call.
 *
 * The pipeline mirrors the upload pipeline deliberately, because the trust problem is
 * identical — bytes arriving from outside:
 *
 *   scan → stage to migration-staging → measure → verify → deduplicate → move → record
 *
 * The size and checksum are what *this server* measured while streaming, never what Drive
 * reported. Drive's `md5Checksum` is kept on the item row as provenance and is never used
 * to decide equality: MD5 is not collision-resistant, exported Google Docs have no MD5 at
 * all, and "these are the same bytes" is a claim this system makes on its own evidence.
 *
 * Everything is resumable. A job that is paused, crashes, or has its access token expire
 * mid-run picks up exactly where it stopped: the item status transition is an atomic
 * claim, and a re-scan updates rows rather than re-importing them.
 */


import { getEnv } from '@/server/config/env';
import { withTransaction } from '@/server/db/connection';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/server/errors/app-error';
import { categoryFor, isAllowedExtension, verifySignature } from '@/server/domain/file-types';
import { nextAvailableName, sanitizeDisplayName } from '@/server/domain/naming';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import { CONFIDENTIALITY_RANK } from '@/server/domain/permissions';
import type { Actor } from '@/server/permissions/actor';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { auditService } from '@/server/audit/audit.service';
import { openSecret, sealSecret } from '@/server/auth/secret-box';
import * as activityRepository from '@/server/repositories/activity.repository';
import * as fileRepository from '@/server/repositories/file.repository';
import * as versionRepository from '@/server/repositories/file-version.repository';
import * as folderRepository from '@/server/repositories/folder.repository';
import * as migrationRepository from '@/server/repositories/migration.repository';
import type {
  MigrationItemRecord,
  MigrationJobRecord,
} from '@/server/repositories/migration.repository';
import * as usageRepository from '@/server/repositories/storage-usage.repository';
import { getStorageProvider } from '@/server/storage';
import { buildMigrationStagingKey, buildOriginalKey, newStorageId } from '@/server/storage/keys';
import type { StorageArea } from '@/server/storage/types';
import { extractExtension, sanitizeFilename } from '@/server/storage/path-safety';
import { getLogger } from '@/server/logging/logger';
import { getMalwareScanner, verdictBlocksContent } from '@/server/security/malware-scanner';
import type { RequestMeta } from '@/server/http/request-meta';
import {
  GOOGLE_EXPORT_FORMATS,
  GOOGLE_FOLDER_MIME,
  GoogleDriveReader,
  buildConsentUrl,
  exchangeCode,
  isDriveConfigured,
  type DriveFile,
  type DriveReader,
} from '@/server/migration/google-drive-client';
import { requireFolder } from './folder-access';

/** Bytes read back from staging to check the file is what its extension claims. */
const SIGNATURE_SAMPLE_BYTES = 4096;
/** Depth guard: a Drive tree deeper than this is a cycle or a mistake, not a folder. */
const MAX_SCAN_DEPTH = 24;
/** Ceiling on one scan, so a runaway tree cannot fill the collection unbounded. */
const MAX_SCANNED_ITEMS = 50_000;

/**
 * Running a migration writes company research into a destination folder under an
 * administrator's authority and connects an external account. It is company-scoped
 * administration, not a department-level action.
 */
function assertMayMigrate(actor: Actor): void {
  try {
    assertCompanyPermission(actor, 'access.manage');
  } catch {
    throw new ForbiddenError('You cannot run Google Drive migrations');
  }
}

async function requireJob(actor: Actor, jobId: string): Promise<MigrationJobRecord> {
  assertMayMigrate(actor);
  const job = await migrationRepository.findJob(jobId);
  if (!job || job.organizationId !== actor.organizationId) throw new NotFoundError();
  return job;
}

/* ------------------------------------------------------------------ create */

export interface CreateMigrationInput {
  name: string;
  description?: string;
  targetFolderId: string;
  sourceFolderIds?: string[];
  confidentiality?: ConfidentialityLevel;
  options?: {
    preserveHierarchy?: boolean;
    preserveDates?: boolean;
    skipDuplicates?: boolean;
    exportGoogleDocs?: boolean;
  };
}

export async function createJob(
  actor: Actor,
  input: CreateMigrationInput,
  meta: RequestMeta,
): Promise<MigrationJobRecord> {
  assertMayMigrate(actor);

  // The destination is checked as an ordinary upload destination, with the ordinary
  // permission. An administrator who may run migrations still cannot import into a
  // folder they could not upload a single file to by hand.
  const target = await requireFolder(actor, input.targetFolderId, 'file.upload');
  if (target.folder.status !== 'active') {
    throw new ConflictError('The destination folder is archived or in the trash');
  }

  const name = sanitizeDisplayName(input.name);
  if (!name) throw new ValidationError('Name the migration');

  // Imported files are never *less* protected than the folder they land in. An import
  // that quietly declassified a confidential folder's contents would be a disclosure
  // dressed up as a data transfer.
  const requested = input.confidentiality ?? target.folder.confidentiality;
  const confidentiality =
    CONFIDENTIALITY_RANK[requested] >= CONFIDENTIALITY_RANK[target.folder.confidentiality]
      ? requested
      : target.folder.confidentiality;

  const job = await migrationRepository.createJob({
    organizationId: actor.organizationId,
    name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    targetFolderId: target.folder.id,
    departmentId: target.folder.departmentId,
    projectId: target.folder.projectId,
    confidentiality,
    sourceFolderIds: normalizeDriveIds(input.sourceFolderIds ?? []),
    ...(input.options ? { options: input.options } : {}),
    createdBy: actor.userId,
  });

  await auditService.recordForActor(actor, meta, {
    action: 'migration.job_updated',
    entityType: 'migration',
    entityId: job.id,
    entityLabel: job.name,
    newValue: {
      targetFolderId: job.targetFolderId,
      confidentiality: job.confidentiality,
      sourceFolderIds: job.sourceFolderIds,
    },
    severity: 'notice',
  });

  return job;
}

export async function listJobs(actor: Actor): Promise<MigrationJobRecord[]> {
  assertMayMigrate(actor);
  return migrationRepository.listJobs(actor.organizationId);
}

export async function getJob(actor: Actor, jobId: string): Promise<MigrationJobRecord> {
  return requireJob(actor, jobId);
}

export async function updateJob(
  actor: Actor,
  jobId: string,
  input: {
    name?: string;
    description?: string;
    sourceFolderIds?: string[];
    options?: CreateMigrationInput['options'];
  },
  meta: RequestMeta,
): Promise<MigrationJobRecord> {
  const job = await requireJob(actor, jobId);
  if (job.status === 'importing' || job.status === 'scanning') {
    throw new ConflictError('Pause the migration before changing it');
  }

  const update: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = sanitizeDisplayName(input.name);
    if (!name) throw new ValidationError('Name the migration');
    update.name = name;
  }
  if (input.description !== undefined) update.description = input.description;
  if (input.sourceFolderIds !== undefined) {
    update.sourceFolderIds = normalizeDriveIds(input.sourceFolderIds);
  }
  for (const [key, value] of Object.entries(input.options ?? {})) {
    if (value !== undefined) update[`options.${key}`] = value;
  }

  const updated = await migrationRepository.updateJob(jobId, { $set: update });
  if (!updated) throw new NotFoundError();

  await auditService.recordForActor(actor, meta, {
    action: 'migration.job_updated',
    entityType: 'migration',
    entityId: jobId,
    entityLabel: updated.name,
    previousValue: { sourceFolderIds: job.sourceFolderIds, options: job.options },
    newValue: update,
  });

  return updated;
}

/**
 * Disconnects and archives a job.
 *
 * Imported files stay exactly where they are. A migration record is a history of what was
 * brought in; deleting it must not delete research that people have been working with for
 * months.
 */
export async function deleteJob(actor: Actor, jobId: string, meta: RequestMeta): Promise<void> {
  const job = await requireJob(actor, jobId);
  if (job.status === 'importing' || job.status === 'scanning') {
    throw new ConflictError('Pause the migration before removing it');
  }

  await migrationRepository.softDeleteJob(jobId, actor.userId);

  await auditService.recordForActor(actor, meta, {
    action: 'migration.job_updated',
    entityType: 'migration',
    entityId: jobId,
    entityLabel: job.name,
    newValue: { removed: true, importedFilesKept: job.counters.imported },
    severity: 'warning',
  });
}

/* ----------------------------------------------------------------- connect */

export interface ConnectStart {
  authorizationUrl: string;
  state: string;
}

/**
 * Starts the Drive consent flow.
 *
 * `state` is a random value the caller stores in a short-lived cookie and the callback
 * compares — the same CSRF binding the sign-in flow uses. It carries the job id so the
 * callback knows which migration the grant belongs to, but the id alone is never trusted:
 * the callback re-checks the actor's permission on that job.
 */
export async function beginConnect(actor: Actor, jobId: string): Promise<ConnectStart> {
  const job = await requireJob(actor, jobId);
  if (!isDriveConfigured()) {
    throw new ValidationError(
      'Google Drive migration is not configured on this deployment. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_DRIVE_REDIRECT_URI.',
    );
  }

  const nonce = crypto.randomUUID();
  const state = `${job.id}:${nonce}`;
  return { authorizationUrl: buildConsentUrl({ state }), state };
}

export async function completeConnect(
  actor: Actor,
  input: { jobId: string; code: string },
  meta: RequestMeta,
): Promise<MigrationJobRecord> {
  const job = await requireJob(actor, input.jobId);

  const grant = await exchangeCode(input.code);

  const updated = await migrationRepository.updateJob(job.id, {
    $set: {
      // Encrypted, not hashed: a resumed migration has to present this value to Google.
      'connection.refreshTokenCipher': await sealSecret(grant.refreshToken),
      'connection.accountEmail': grant.accountEmail,
      'connection.scope': grant.scope,
      'connection.connectedAt': new Date(),
      'connection.connectedBy': actor.userId,
      status: job.status === 'draft' ? 'connected' : job.status,
      lastError: null,
    },
  });
  if (!updated) throw new NotFoundError();

  await auditService.recordForActor(actor, meta, {
    action: 'migration.job_updated',
    entityType: 'migration',
    entityId: job.id,
    entityLabel: job.name,
    // The token is not in this record and there is no field here to put it in.
    newValue: { connected: true, accountEmail: grant.accountEmail, scope: grant.scope },
    severity: 'notice',
  });

  return updated;
}

/** Builds the live reader for a job, or explains why it cannot. */
async function readerFor(jobId: string): Promise<DriveReader> {
  const cipher = await migrationRepository.getRefreshTokenCipher(jobId);
  const refreshToken = await openSecret(cipher);
  if (!refreshToken) {
    throw new ConflictError('This migration is not connected to a Google account');
  }
  return new GoogleDriveReader(refreshToken);
}

/* -------------------------------------------------------------------- scan */

export interface ScanResult {
  files: number;
  folders: number;
  bytes: number;
  truncated: boolean;
}

/**
 * Walks the selected Drive folders and records what is there.
 *
 * Folders are created in the destination *during the scan*, and each file row stores the
 * local folder it will land in. That makes the folder map durable: a job resumed next
 * week does not need to re-derive the hierarchy, and an interrupted import cannot file
 * the second half of a folder somewhere different from the first.
 *
 * The cost is honest and stated in the UI: an abandoned scan leaves empty folders behind.
 * An empty folder is a visible, deletable artefact; a half-mapped hierarchy is a silent
 * corruption of where research lives.
 */
export async function scan(
  actor: Actor,
  jobId: string,
  meta: RequestMeta,
  injectedReader?: DriveReader,
): Promise<ScanResult> {
  const job = await requireJob(actor, jobId);

  // `completed` is included: a finished migration is rescanned when Drive has gained new
  // files since, which is the ordinary way a long move happens. Only `draft` (never
  // connected), `scanning` and `importing` refuse — a scan cannot start while one is
  // already walking the tree or bytes are moving.
  const claimed = await migrationRepository.claimJobForRun(
    jobId,
    ['connected', 'scanned', 'paused', 'needs_review', 'partially_completed', 'completed', 'failed'],
    'scanning',
    { scanStartedAt: new Date() },
  );
  if (!claimed) {
    throw new ConflictError('This migration is already running, or has not been connected yet');
  }

  const reader = injectedReader ?? (await readerFor(jobId));
  const target = await requireFolder(actor, job.targetFolderId, 'file.upload');

  const result: ScanResult = { files: 0, folders: 0, bytes: 0, truncated: false };

  try {
    // An empty selection means "the whole of My Drive", which is what Drive itself calls
    // `root`. Stated explicitly rather than implied by an empty array.
    const roots = job.sourceFolderIds.length > 0 ? job.sourceFolderIds : ['root'];

    for (const root of roots) {
      if (result.truncated) break;
      await scanFolder({
        actor,
        job,
        reader,
        driveFolderId: root,
        localFolderId: target.folder.id,
        sourcePath: '',
        depth: 0,
        result,
      });
    }

    await migrationRepository.updateJob(jobId, {
      $set: {
        status: 'scanned',
        scanCompletedAt: new Date(),
        'counters.scannedFiles': result.files,
        'counters.scannedFolders': result.folders,
        'counters.scannedBytes': result.bytes,
      },
    });

    await auditService.recordForActor(actor, meta, {
      action: 'migration.job_updated',
      entityType: 'migration',
      entityId: jobId,
      entityLabel: job.name,
      newValue: { scanned: result },
      severity: 'notice',
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scan failed';
    await migrationRepository.updateJob(jobId, {
      $set: { status: 'failed', lastError: message.slice(0, 1000) },
    });
    throw error;
  }
}

async function scanFolder(input: {
  actor: Actor;
  job: MigrationJobRecord;
  reader: DriveReader;
  driveFolderId: string;
  localFolderId: string;
  sourcePath: string;
  depth: number;
  result: ScanResult;
}): Promise<void> {
  if (input.depth > MAX_SCAN_DEPTH) return;

  let pageToken: string | undefined;

  do {
    const page = await input.reader.listChildren(input.driveFolderId, pageToken);
    pageToken = page.nextPageToken;

    for (const entry of page.files) {
      if (entry.trashed) continue;
      if (input.result.files >= MAX_SCANNED_ITEMS) {
        input.result.truncated = true;
        return;
      }

      const childPath = input.sourcePath ? `${input.sourcePath}/${entry.name}` : entry.name;

      if (entry.mimeType === GOOGLE_FOLDER_MIME) {
        const localFolderId = input.job.options.preserveHierarchy
          ? await ensureLocalFolder(input.actor, input.job, input.localFolderId, entry.name)
          : input.localFolderId;

        input.result.folders += 1;
        await scanFolder({ ...input, driveFolderId: entry.id, localFolderId, sourcePath: childPath, depth: input.depth + 1 });
        continue;
      }

      await recordScannedFile({
        job: input.job,
        entry,
        localFolderId: input.localFolderId,
        sourcePath: childPath,
      });
      input.result.files += 1;
      input.result.bytes += Number(entry.size ?? 0);
    }
  } while (pageToken);
}

/**
 * Mirrors one Drive folder into the destination.
 *
 * Idempotent by name, so a re-scan reuses the folder rather than creating
 * "Raw Data (2)" — the drive already refuses two folders with the same name in one
 * parent, and a migration must not be the thing that starts working around that.
 */
async function ensureLocalFolder(
  actor: Actor,
  job: MigrationJobRecord,
  parentFolderId: string,
  rawName: string,
): Promise<string> {
  const name = sanitizeDisplayName(rawName) || 'Imported folder';
  const existing = await folderRepository.findChildByName(parentFolderId, name.toLowerCase());
  if (existing) return existing.id;

  // Internal: the import job authorized its target folder when it was created, and this walks
  // down from there building the mirrored tree.
  const parent = await folderRepository.findByIdInternal(parentFolderId);
  if (!parent) throw new NotFoundError();

  const folder = await folderRepository.create({
    organizationId: actor.organizationId,
    name,
    parentFolderId: parent.id,
    pathAncestors: [...parent.pathAncestors, parent.id],
    depth: parent.depth + 1,
    driveType: parent.driveType,
    ownerId: parent.ownerId,
    departmentId: parent.departmentId,
    projectId: parent.projectId,
    confidentiality: job.confidentiality,
    description: 'Imported from Google Drive',
    createdBy: actor.userId,
  });

  await folderRepository.adjustChildFolderCount(parent.id, 1);
  return folder.id;
}

async function recordScannedFile(input: {
  job: MigrationJobRecord;
  entry: DriveFile;
  localFolderId: string;
  sourcePath: string;
}): Promise<void> {
  const isGoogleNative = input.entry.mimeType.startsWith('application/vnd.google-apps.');

  await migrationRepository.upsertItem({
    organizationId: input.job.organizationId,
    jobId: input.job.id,
    driveFileId: input.entry.id,
    driveParentId: input.entry.parents?.[0] ?? null,
    sourcePath: input.sourcePath,
    name: input.entry.name,
    mimeType: input.entry.mimeType,
    declaredSize: Number(input.entry.size ?? 0),
    driveMd5: input.entry.md5Checksum ?? null,
    driveCreatedTime: input.entry.createdTime ? new Date(input.entry.createdTime) : null,
    driveModifiedTime: input.entry.modifiedTime ? new Date(input.entry.modifiedTime) : null,
    isGoogleNative,
  });

  // Recorded outside the upsert so a re-scan that moves a file in Drive also moves where
  // it will land here — without disturbing an item that has already been imported.
  await migrationRepository.updateItemTargetIfPending(
    input.job.id,
    input.entry.id,
    input.localFolderId,
  );
}

/* ------------------------------------------------------------------ import */

export interface ImportRunResult {
  processed: number;
  imported: number;
  skippedDuplicates: number;
  skippedUnsupported: number;
  failed: number;
  remaining: number;
  status: MigrationJobRecord['status'];
}

/**
 * Imports up to `limit` pending items.
 *
 * Bounded on purpose. A request handler that imported forty thousand files would hold a
 * connection open for hours and lose everything to one timeout; the UI calls this
 * repeatedly and shows progress, and any call can be the last one without losing work.
 */
export async function runImport(
  actor: Actor,
  jobId: string,
  meta: RequestMeta,
  options: { limit?: number; reader?: DriveReader } = {},
): Promise<ImportRunResult> {
  const job = await requireJob(actor, jobId);
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);

  const claimed = await migrationRepository.claimJobForRun(
    jobId,
    [
      'scanned',
      'paused',
      'needs_review',
      'partially_completed',
      'completed',
      'failed',
      'importing',
    ],
    'importing',
    { importStartedAt: job.importStartedAt ?? new Date() },
  );
  if (!claimed) throw new ConflictError('This migration cannot be run in its current state');

  const reader = options.reader ?? (await readerFor(jobId));

  const result: ImportRunResult = {
    processed: 0,
    imported: 0,
    skippedDuplicates: 0,
    skippedUnsupported: 0,
    failed: 0,
    remaining: 0,
    status: 'importing',
  };

  for (let index = 0; index < limit; index += 1) {
    // Re-read the job every iteration: "pause" has to take effect within one file, not
    // at the end of a batch of two hundred.
    const current = await migrationRepository.findJob(jobId);
    if (!current || current.status !== 'importing') break;

    const item = await migrationRepository.claimNextPendingItem(jobId);
    if (!item) break;

    result.processed += 1;
    try {
      const outcome = await importItem(actor, job, item, reader, meta);
      if (outcome === 'imported') result.imported += 1;
      else if (outcome === 'skipped_duplicate') result.skippedDuplicates += 1;
      else result.skippedUnsupported += 1;
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message : 'Import failed';
      getLogger().warn({ jobId, itemId: item.id, err: error }, 'Migration item failed');
      await migrationRepository.updateItem(item.id, {
        $set: { status: 'failed', lastError: message.slice(0, 1000) },
      });
      await migrationRepository.incrementCounters(jobId, { failed: 1 });
    }
  }

  const counts = await migrationRepository.countItemsByStatus(jobId);
  result.remaining = (counts.pending ?? 0) + (counts.importing ?? 0);
  result.status = await settleStatus(jobId, counts);

  return result;
}

/**
 * Decides what the job is now.
 *
 * `completed` is reserved for a job with nothing left and nothing wrong. Anything that
 * was skipped or failed leaves it in a state that says a human should look — a migration
 * reported as complete while forty files silently failed is exactly the outcome the
 * audit requirement exists to prevent.
 */
async function settleStatus(
  jobId: string,
  counts: Record<string, number>,
): Promise<MigrationJobRecord['status']> {
  const remaining = (counts.pending ?? 0) + (counts.importing ?? 0);
  const problems = (counts.failed ?? 0) + (counts.needs_review ?? 0);
  const skipped = (counts.skipped_duplicate ?? 0) + (counts.skipped_unsupported ?? 0);

  const status: MigrationJobRecord['status'] =
    remaining > 0
      ? 'paused'
      : problems > 0
        ? 'partially_completed'
        : skipped > 0
          ? 'needs_review'
          : 'completed';

  await migrationRepository.updateJob(jobId, {
    $set: {
      status,
      ...(remaining === 0 ? { completedAt: new Date() } : {}),
    },
  });
  return status;
}

type ImportOutcome = 'imported' | 'skipped_duplicate' | 'skipped_unsupported';

async function importItem(
  actor: Actor,
  job: MigrationJobRecord,
  item: MigrationItemRecord,
  reader: DriveReader,
  meta: RequestMeta,
): Promise<ImportOutcome> {
  const env = getEnv();
  const storage = getStorageProvider();

  // Already imported by an earlier job? Recording it as a duplicate keeps the report
  // honest without storing the bytes a third time.
  const already = await migrationRepository.findImportedByDriveFileId(
    job.organizationId,
    item.driveFileId,
  );
  if (already && already.jobId !== job.id) {
    await migrationRepository.updateItem(item.id, {
      $set: {
        status: 'skipped_duplicate',
        duplicateOfFileId: already.resultFileId,
        lastError: null,
      },
    });
    await migrationRepository.incrementCounters(job.id, { skippedDuplicates: 1 });
    return 'skipped_duplicate';
  }

  const naming = resolveName(job, item);
  if (!naming) {
    await migrationRepository.updateItem(item.id, {
      $set: {
        status: 'skipped_unsupported',
        lastError: item.isGoogleNative
          ? 'Google-native document with no supported export format'
          : 'File type is not accepted by this platform',
      },
    });
    await migrationRepository.incrementCounters(job.id, { skippedUnsupported: 1 });
    return 'skipped_unsupported';
  }

  const targetFolderId = item.targetFolderId ?? job.targetFolderId;
  // Internal: `file.upload` on the job's target folder was asserted when the job was created,
  // and this runs on the worker rather than inside the requesting user's session.
  const folder = await folderRepository.findByIdInternal(targetFolderId);
  if (!folder) throw new NotFoundError();

  // Stage first. The bytes land in migration-staging, outside the served tree and outside
  // the live originals — so a file that fails verification never existed as far as the
  // drive is concerned.
  const staging = buildMigrationStagingKey({
    migrationJobId: physicalId(job.id),
    migrationItemId: physicalId(item.id),
  });
  await storage.deleteFile(staging.key, staging.area).catch(() => undefined);

  const body = item.isGoogleNative
    ? await reader.export(item.driveFileId, naming.exportMimeType!)
    : await reader.download(item.driveFileId);

  // A ceiling, not an exact length: an exported Google Doc has no size to declare, and
  // Drive's reported size for a binary file is advisory (this module's whole position is
  // that measurements come from here, not from Drive).
  const stored = await storage.saveFile({
    key: staging.key,
    area: staging.area,
    body,
    maxBytes: env.maxUploadBytes,
  });

  try {
    if (stored.size === 0) throw new ValidationError('Google Drive returned an empty file');

    // The signature check the upload path applies, applied here too. Bytes from Drive are
    // no more trustworthy than bytes from a browser — a `.pdf` in someone's Drive that is
    // actually an executable is precisely the case this catches.
    const head = await readHead(staging.key, staging.area, stored.size);
    const verdict = verifySignature(naming.extension, head);
    if (!verdict.ok) {
      await storage.deleteFile(staging.key, staging.area).catch(() => undefined);
      await migrationRepository.updateItem(item.id, {
        $set: { status: 'needs_review', lastError: verdict.reason },
      });
      await migrationRepository.incrementCounters(job.id, { skippedUnsupported: 1 });
      return 'skipped_unsupported';
    }

    // Scanned in staging, before the move, exactly as an upload is. Content from a
    // company Drive is not more trustworthy than content from a browser — a decade of
    // accumulated attachments is if anything the more likely place to find something.
    const scan = await getMalwareScanner().scan(
      await storage.getFile(staging.key, staging.area),
      item.name,
    );
    const blocking = verdictBlocksContent(scan);
    if (blocking.blocked) {
      await storage.deleteFile(staging.key, staging.area).catch(() => undefined);
      await migrationRepository.updateItem(item.id, {
        $set: { status: 'needs_review', lastError: blocking.reason },
      });
      await migrationRepository.incrementCounters(job.id, { skippedUnsupported: 1 });
      return 'skipped_unsupported';
    }

    // Deduplication on *our* checksum, measured while streaming — never Drive's MD5.
    if (job.options.skipDuplicates) {
      const existing = await fileRepository.findByChecksum(job.organizationId, stored.checksumSha256);
      if (existing) {
        await storage.deleteFile(staging.key, staging.area).catch(() => undefined);
        await migrationRepository.updateItem(item.id, {
          $set: {
            status: 'skipped_duplicate',
            duplicateOfFileId: existing.id,
            checksumSha256: stored.checksumSha256,
            lastError: null,
          },
        });
        await migrationRepository.incrementCounters(job.id, { skippedDuplicates: 1 });
        return 'skipped_duplicate';
      }
    }

    const taken = await fileRepository.takenNamesInFolder(folder.id);
    const displayName = nextAvailableName(naming.displayName, taken);

    const fileId = fileRepository.newId();
    const physicalName = newStorageId();
    const destination = buildOriginalKey({
      organizationId: job.organizationId,
      departmentId: folder.departmentId,
      fileId,
      versionId: physicalName,
    });

    await storage.moveFile(
      { key: staging.key, area: staging.area },
      { key: destination.key, area: destination.area },
    );

    try {
      const created = await withTransaction(async (session) => {
        const file = await fileRepository.create(
          {
            id: fileId,
            organizationId: job.organizationId,
            displayName,
            originalFilename: naming.originalFilename,
            extension: naming.extension,
            category: categoryFor(naming.extension),
            folderId: folder.id,
            folderPathAncestors: [...folder.pathAncestors, folder.id],
            driveType: folder.driveType,
            // The administrator who ran the import owns the result. Attributing it to the
            // Drive account would mean an owner who has no account on this platform and
            // therefore no one accountable for the file.
            ownerId: folder.driveType === 'my' ? folder.ownerId : actor.userId,
            departmentId: folder.departmentId,
            projectId: folder.projectId,
            confidentiality: job.confidentiality,
            sizeBytes: stored.size,
            mimeType: naming.mimeType,
            checksumSha256: stored.checksumSha256,
            createdBy: actor.userId,
            // Provenance: where this came from, kept on the file itself so it survives
            // the migration job being removed.
            metadata: {
              description: `Imported from Google Drive: ${item.sourcePath || item.name}`,
            },
            // "Preserve dates where possible" — a research archive whose files all claim
            // to have been created on migration day is worthless for provenance.
            ...(job.options.preserveDates && item.driveCreatedTime
              ? {
                  createdAt: item.driveCreatedTime,
                  updatedAt: item.driveModifiedTime ?? item.driveCreatedTime,
                }
              : {}),
          },
          session,
        );

        const version = await versionRepository.create(
          {
            organizationId: job.organizationId,
            fileId: file.id,
            versionNumber: 1,
            storageKey: destination.key,
            storageArea: destination.area,
            relativeStoragePath: `${destination.area}/${destination.key}`,
            storedFilename: physicalName,
            originalFilename: naming.originalFilename,
            fileSize: stored.size,
            mimeType: naming.mimeType,
            extension: naming.extension,
            checksumSha256: stored.checksumSha256,
            uploadedBy: actor.userId,
            versionNote: `Imported from Google Drive (${item.driveFileId})`,
            ...(job.options.preserveDates && item.driveModifiedTime
              ? { uploadedAt: item.driveModifiedTime }
              : {}),
          },
          session,
        );

        await versionRepository.setCurrent(file.id, version.id, session);
        await fileRepository.updateById(
          file.id,
          { $set: { currentVersionId: version.id }, $inc: { versionCount: 1 } },
          session,
        );

        await folderRepository.updateById(folder.id, { fileCountDelta: 1 }, session);
        await usageRepository.applyDelta(
          {
            userId: actor.userId,
            departmentId: folder.departmentId,
            projectId: folder.projectId,
            bytes: stored.size,
          },
          session,
        );

        return { fileId: file.id, versionId: version.id };
      });

      await migrationRepository.updateItem(item.id, {
        $set: {
          status: 'imported',
          resultFileId: created.fileId,
          resultVersionId: created.versionId,
          checksumSha256: stored.checksumSha256,
          importedBytes: stored.size,
          targetFolderId: folder.id,
          importedAt: new Date(),
          lastError: null,
        },
      });
      await migrationRepository.incrementCounters(job.id, {
        imported: 1,
        importedBytes: stored.size,
      });

      // One audit record per imported file — "every migration item has an audit history".
      await auditService.recordForActor(actor, meta, {
        action: 'migration.import_item',
        entityType: 'file',
        entityId: created.fileId,
        entityLabel: displayName,
        newValue: {
          jobId: job.id,
          driveFileId: item.driveFileId,
          sourcePath: item.sourcePath,
          sizeBytes: stored.size,
          checksumSha256: stored.checksumSha256,
          folderId: folder.id,
        },
        severity: 'notice',
      });

      void activityRepository
        .append({
          organizationId: job.organizationId,
          actorUserId: actor.userId,
          actorName: actor.name,
          action: 'file.upload',
          entityType: 'file',
          entityId: created.fileId,
          entityLabel: displayName,
          contextFolderIds: [...folder.pathAncestors, folder.id],
          departmentId: folder.departmentId,
          projectId: folder.projectId,
          detail: { importedFrom: 'google_drive' },
        })
        .catch(() => undefined);

      return 'imported';
    } catch (error) {
      // Bytes in place with no record pointing at them: remove them, or the volume fills
      // with objects nothing can ever reference.
      await storage.deleteFile(destination.key, destination.area).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await storage.deleteFile(staging.key, staging.area).catch(() => undefined);
    throw error;
  }
}

/* ------------------------------------------------------- pause / resume */

export async function pause(
  actor: Actor,
  jobId: string,
  meta: RequestMeta,
): Promise<MigrationJobRecord> {
  const job = await requireJob(actor, jobId);
  const updated = await migrationRepository.updateJob(jobId, { $set: { status: 'paused' } });
  if (!updated) throw new NotFoundError();

  await auditService.recordForActor(actor, meta, {
    action: 'migration.job_updated',
    entityType: 'migration',
    entityId: jobId,
    entityLabel: job.name,
    newValue: { status: 'paused' },
  });
  return updated;
}

/**
 * Returns failed and stuck items to the queue.
 *
 * `importing` items are reset too: an item left mid-flight by a crashed run holds no
 * bytes (the staging file is removed on the way out) and would otherwise be stranded.
 */
export async function retryFailed(
  actor: Actor,
  jobId: string,
  meta: RequestMeta,
): Promise<{ requeued: number }> {
  const job = await requireJob(actor, jobId);
  if (job.status === 'importing') {
    throw new ConflictError('Pause the migration before retrying failed items');
  }

  const requeued = await migrationRepository.resetFailedItems(jobId);
  await migrationRepository.updateJob(jobId, {
    $set: { status: requeued > 0 ? 'paused' : job.status, lastError: null },
    // The counter is a running tally of failures *now*, not of failures ever; leaving it
    // would make a fully retried job report failures it no longer has.
    $inc: { 'counters.failed': -Math.min(requeued, job.counters.failed) },
  });

  await auditService.recordForActor(actor, meta, {
    action: 'migration.job_updated',
    entityType: 'migration',
    entityId: jobId,
    entityLabel: job.name,
    newValue: { requeued },
  });

  return { requeued };
}

/* ------------------------------------------------------------------ report */

export interface MigrationReport {
  job: MigrationJobRecord;
  byStatus: Record<string, number>;
  /** The rows a human has to look at: failures, skips and flags. */
  attention: MigrationItemRecord[];
}

export async function report(actor: Actor, jobId: string): Promise<MigrationReport> {
  const job = await requireJob(actor, jobId);
  const byStatus = await migrationRepository.countItemsByStatus(jobId);

  const attention: MigrationItemRecord[] = [];
  for (const status of ['failed', 'needs_review', 'skipped_unsupported', 'skipped_duplicate'] as const) {
    const { items } = await migrationRepository.listItems({
      jobId,
      status,
      page: 1,
      pageSize: 25,
    });
    attention.push(...items);
  }

  return { job, byStatus, attention };
}

export async function listItems(
  actor: Actor,
  jobId: string,
  input: { status?: MigrationItemRecord['status']; page: number; pageSize: number },
): Promise<{ items: MigrationItemRecord[]; total: number }> {
  await requireJob(actor, jobId);
  return migrationRepository.listItems({
    jobId,
    ...(input.status ? { status: input.status } : {}),
    page: input.page,
    pageSize: input.pageSize,
  });
}

/* ---------------------------------------------------------------- helpers */

interface ResolvedName {
  displayName: string;
  originalFilename: string;
  extension: string;
  mimeType: string;
  /** Set for Google-native documents: the format to ask Drive to export. */
  exportMimeType?: string;
}

/**
 * Decides what an imported file will be called and whether it is acceptable at all.
 *
 * Returns null for anything this platform does not accept, which becomes a *reported
 * skip* rather than a silent omission. The extension decides the type here exactly as it
 * does for uploads; Drive's declared MIME type is never the authority.
 */
function resolveName(job: MigrationJobRecord, item: MigrationItemRecord): ResolvedName | null {
  const safeName = sanitizeFilename(item.name) || 'imported-file';

  if (item.isGoogleNative) {
    if (!job.options.exportGoogleDocs) return null;
    const format = GOOGLE_EXPORT_FORMATS[item.mimeType];
    if (!format) return null;

    // Google Docs have no filename extension at all, so one is appended rather than
    // substituted — "Protocol v3" becomes "Protocol v3.docx".
    const base = safeName.replace(/\.+$/, '');
    const filename = `${base}.${format.extension}`;
    return {
      displayName: sanitizeDisplayName(filename) || filename,
      originalFilename: filename,
      extension: format.extension,
      mimeType: format.mimeType,
      exportMimeType: format.mimeType,
    };
  }

  const extension = extractExtension(safeName);
  if (!extension || !isAllowedExtension(extension)) return null;

  return {
    displayName: sanitizeDisplayName(safeName) || safeName,
    originalFilename: safeName,
    extension,
    mimeType: item.mimeType || 'application/octet-stream',
  };
}

async function readHead(key: string, area: StorageArea, size: number): Promise<Buffer> {
  const storage = getStorageProvider();
  const end = Math.min(SIGNATURE_SAMPLE_BYTES, size) - 1;
  const stream = await storage.getFile(key, area, { range: { start: 0, end } });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/** Storage keys reject anything that is not a plain identifier. */
function physicalId(value: string): string {
  return value.replace(/[^A-Za-z0-9-]/g, '');
}

/**
 * Drive ids are opaque strings from Google. They are length-capped and stripped of
 * anything outside the character set Google actually uses, so a pasted value cannot
 * carry a quote into a Drive query or a separator into a storage key.
 */
function normalizeDriveIds(values: string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || value.length > 200) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new ValidationError(`"${raw}" is not a valid Google Drive folder id`);
    }
    if (!out.includes(value)) out.push(value);
  }
  return out.slice(0, 50);
}

export const migrationService = {
  createJob,
  listJobs,
  getJob,
  updateJob,
  deleteJob,
  beginConnect,
  completeConnect,
  scan,
  runImport,
  pause,
  retryFailed,
  report,
  listItems,
};
