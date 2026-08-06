/**
 * Secure upload pipeline.
 *
 * The order matters and is the whole point (docs/phase-0/06-flows.md):
 *
 *   authorize → session → stream to quarantine → measure → verify → move → record
 *
 * Nothing is accepted before permission, type and quota have been decided, the bytes
 * never touch the served tree, the size and checksum are what the server *measured*
 * rather than what the client claimed, and the metadata is written only once the bytes
 * are safely in place. A failure at any step leaves no half-file and no orphan record.
 */
import { createHash } from 'crypto';
import { Readable } from 'stream';

import { getEnv } from '@/server/config/env';
import { withTransaction } from '@/server/db/connection';
import {
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  QuotaExceededError,
  ServiceUnavailableError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '@/server/errors/app-error';
import {
  canonicalMimeType,
  categoryFor,
  isAllowedExtension,
  mimeMatchesExtension,
  verifySignature,
} from '@/server/domain/file-types';
import { enforce, RATE_LIMITS } from '@/server/auth/rate-limit';
import { nextAvailableName, sanitizeDisplayName } from '@/server/domain/naming';
import type { Actor } from '@/server/permissions/actor';
import { auditService } from '@/server/audit/audit.service';
import * as activityRepository from '@/server/repositories/activity.repository';
import * as fileRepository from '@/server/repositories/file.repository';
import * as versionRepository from '@/server/repositories/file-version.repository';
import * as folderRepository from '@/server/repositories/folder.repository';
import * as reviewRepository from '@/server/repositories/review.repository';
import * as sessionRepository from '@/server/repositories/upload-session.repository';
import * as usageRepository from '@/server/repositories/storage-usage.repository';
import { getStorageProvider, storageRegistry } from '@/server/storage';
import { getGoogleDriveStorage, isDriveStorageEnabled } from '@/server/storage/google';
import { requireDriveStore, transferVersion } from './storage-migration/transfer';
import { queueForDrive } from './storage-migration/pending-transfers';
import {
  buildOriginalKey,
  buildQuarantineKey,
  buildTemporaryChunkKey,
  newStorageId,
} from '@/server/storage/keys';
import type { StorageArea } from '@/server/storage/types';
import { extractExtension, sanitizeFilename } from '@/server/storage/path-safety';
import { getLogger } from '@/server/logging/logger';
import { getMalwareScanner, verdictBlocksContent } from '@/server/security/malware-scanner';
import type { RequestMeta } from '@/server/http/request-meta';
import { requireFolder } from './folder-access';
import { requireFile } from './file-access';

/** Bytes read back from quarantine to check the file really is what it claims. */
const SIGNATURE_SAMPLE_BYTES = 4096;

export interface AuthorizeUploadInput {
  folderId: string;
  filename: string;
  size: number;
  mimeType?: string;
  /** Present when this upload is a new version of an existing file. */
  targetFileId?: string;
  versionNote?: string;
  /** Set to opt into chunked/resumable upload. */
  chunked?: boolean;
}

export interface UploadTicket {
  sessionId: string;
  status: string;
  displayName: string;
  extension: string;
  maxBytes: number;
  chunkSize: number;
  totalChunks: number;
  expiresAt: Date;
  /** Set when the same bytes already exist here, so the client can offer to skip. */
  duplicateOfFileId?: string;
}

/* -------------------------------------------------------------- authorize */

export async function authorizeUpload(
  actor: Actor,
  input: AuthorizeUploadInput,
  meta: RequestMeta,
): Promise<UploadTicket> {
  const env = getEnv();

  // 0. Rate limit before anything else. Every step below costs a database round trip,
  //    and a successful authorization reserves quota and a quarantine slot that survive
  //    until the session expires — so this is the cheapest place to stop an abusive
  //    client, and the only place that stops it before it consumes anything.
  enforce(`upload:authorize:${actor.userId}`, RATE_LIMITS.uploadAuthorize);

  // 1. Permission on the destination — uploading a new version is a different right
  //    from uploading a new file.
  const folder = await requireFolder(
    actor,
    input.folderId,
    input.targetFileId ? 'version.upload' : 'file.upload',
  );
  if (folder.folder.status !== 'active') {
    throw new ConflictError('You cannot upload into an archived or trashed folder');
  }

  if (input.targetFileId) {
    const target = await requireFile(actor, input.targetFileId, 'version.upload');
    if (target.file.folderId !== folder.folder.id) {
      throw new ValidationError('That file is not in the folder you selected');
    }
  }

  // 2. Name and type. The extension decides; the declared MIME type is only ever a
  //    cross-check, never the authority.
  const safeFilename = sanitizeFilename(input.filename);
  const extension = extractExtension(safeFilename);
  if (!extension) {
    throw new UnsupportedMediaTypeError('Files must have a file extension');
  }
  if (!isAllowedExtension(extension)) {
    throw new UnsupportedMediaTypeError(
      `.${extension} files are not accepted. Package unusual formats in a .zip if you need to store them.`,
      { extension },
    );
  }
  if (!mimeMatchesExtension(extension, input.mimeType)) {
    throw new UnsupportedMediaTypeError(
      `The file type reported by your browser does not match a .${extension} file`,
    );
  }

  // 3. Size, before a single byte is accepted.
  if (!Number.isFinite(input.size) || input.size < 0) {
    throw new ValidationError('Declare the file size');
  }
  if (input.size > env.maxUploadBytes) {
    throw new PayloadTooLargeError(
      `Files are limited to ${env.MAX_UPLOAD_SIZE_MB} MB. This one is ${Math.ceil(input.size / 1024 ** 2)} MB.`,
    );
  }

  // 4. Quota and physical headroom.
  await assertQuota(actor, folder.folder.departmentId, input.size);
  await assertDiskHeadroom(input.size);

  const displayName = await resolveDisplayName(folder.folder.id, safeFilename, Boolean(input.targetFileId));
  const chunkSize = input.chunked ? env.uploadChunkBytes : 0;
  const totalChunks = chunkSize > 0 ? Math.max(1, Math.ceil(input.size / chunkSize)) : 0;

  const session = await sessionRepository.create({
    organizationId: actor.organizationId,
    userId: actor.userId,
    folderId: folder.folder.id,
    targetFileId: input.targetFileId ?? null,
    declaredFilename: safeFilename,
    displayName,
    extension,
    declaredSize: input.size,
    declaredMimeType: input.mimeType ?? null,
    resolvedMimeType: canonicalMimeType(extension),
    ...(input.versionNote !== undefined ? { versionNote: input.versionNote } : {}),
    chunkSize,
    totalChunks,
    expiresAt: new Date(Date.now() + env.INCOMPLETE_UPLOAD_RETENTION_HOURS * 3600_000),
  });

  void auditService
    .recordForActor(actor, meta, {
      action: 'file.upload',
      entityType: 'upload_session',
      entityId: session.id,
      entityLabel: displayName,
      newValue: { folderId: folder.folder.id, declaredSize: input.size, extension },
      outcome: 'success',
    })
    .catch(() => undefined);

  return {
    sessionId: session.id,
    status: session.status,
    displayName,
    extension,
    maxBytes: env.maxUploadBytes,
    chunkSize,
    totalChunks,
    expiresAt: session.expiresAt,
  };
}

/* ---------------------------------------------------------------- receive */

/**
 * Single-shot streaming upload.
 *
 * The body is piped straight into quarantine; the provider hashes and counts as it
 * writes and aborts past `expectedSize`, so an oversized or lying client is stopped
 * mid-stream rather than after the disk has filled.
 */
export async function receiveStream(
  actor: Actor,
  sessionId: string,
  body: Readable,
): Promise<{ receivedBytes: number; checksumSha256: string }> {
  const session = await requireOwnSession(actor, sessionId, ['pending', 'uploading']);
  const storage = getStorageProvider();
  const quarantine = buildQuarantineKey({ uploadSessionId: physicalId(session.id) });

  try {
    const stored = await storage.saveFile({
      key: quarantine.key,
      area: quarantine.area,
      body,
      expectedSize: session.declaredSize,
      contentType: session.resolvedMimeType,
    });

    await sessionRepository.update(sessionId, {
      $set: {
        status: 'uploading',
        receivedBytes: stored.size,
        checksumSha256: stored.checksumSha256,
        quarantineKey: quarantine.key,
      },
    });

    return { receivedBytes: stored.size, checksumSha256: stored.checksumSha256 };
  } catch (error) {
    await failSession(sessionId, error instanceof Error ? error.message : 'Upload failed');
    throw error;
  }
}

/** One chunk of a resumable upload. Re-sending a chunk is safe and does not double-count. */
export async function receiveChunk(
  actor: Actor,
  sessionId: string,
  chunkIndex: number,
  chunk: Buffer,
): Promise<{ receivedChunks: number[]; totalChunks: number }> {
  const session = await requireOwnSession(actor, sessionId, ['pending', 'uploading']);
  if (session.chunkSize <= 0) {
    throw new ValidationError('This upload was not started as a chunked upload');
  }
  if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
    throw new ValidationError('Chunk index is outside this upload');
  }
  if (chunk.byteLength > session.chunkSize) {
    throw new PayloadTooLargeError('Chunk is larger than the agreed chunk size');
  }

  const storage = getStorageProvider();
  const key = buildTemporaryChunkKey({ uploadSessionId: physicalId(session.id), chunkIndex });

  // A retried chunk overwrites nothing: the previous attempt is removed first, so the
  // exclusive-create rule in the provider still holds.
  await storage.deleteFile(key.key, key.area).catch(() => undefined);
  await storage.saveFile({
    key: key.key,
    area: key.area,
    body: Readable.from(chunk),
    expectedSize: chunk.byteLength,
  });

  const alreadyReceived = session.receivedChunks.includes(chunkIndex);
  const updated = await sessionRepository.recordChunk(
    sessionId,
    chunkIndex,
    alreadyReceived ? 0 : chunk.byteLength,
  );

  return {
    receivedChunks: updated?.receivedChunks ?? [],
    totalChunks: session.totalChunks,
  };
}

/* --------------------------------------------------------------- finalize */

export interface FinalizedUpload {
  fileId: string;
  versionId: string;
  versionNumber: number;
  displayName: string;
  sizeBytes: number;
  checksumSha256: string;
  isNewFile: boolean;
}

/**
 * Turns a completed upload into a file.
 *
 * Idempotent by construction: the status transition out of `uploading` is an atomic
 * claim, so a client that retries after a timeout does not create a second file — it
 * gets the result the first call already produced.
 */
export async function finalize(
  actor: Actor,
  sessionId: string,
  meta: RequestMeta,
): Promise<FinalizedUpload> {
  const existing = await sessionRepository.findById(sessionId);
  if (!existing || existing.userId !== actor.userId) throw new NotFoundError();

  if (existing.status === 'ready' && existing.resultFileId && existing.resultVersionId) {
    return describeExistingResult(existing.resultFileId, existing.resultVersionId);
  }

  const claimed = await sessionRepository.claimForFinalization(sessionId, crypto.randomUUID());
  if (!claimed) {
    const current = await sessionRepository.findById(sessionId);
    if (current?.status === 'ready' && current.resultFileId && current.resultVersionId) {
      return describeExistingResult(current.resultFileId, current.resultVersionId);
    }
    if (current?.status === 'processing') {
      throw new ConflictError('This upload is already being finalized');
    }
    throw new ConflictError('This upload can no longer be finalized', 'UPLOAD_SESSION_EXPIRED');
  }

  try {
    return await buildFileFromSession(actor, claimed, meta);
  } catch (error) {
    await failSession(sessionId, error instanceof Error ? error.message : 'Finalization failed');
    throw error;
  }
}

async function buildFileFromSession(
  actor: Actor,
  session: sessionRepository.UploadSessionRecord,
  meta: RequestMeta,
): Promise<FinalizedUpload> {
  const storage = getStorageProvider();
  const folderContext = await requireFolder(
    actor,
    session.folderId,
    session.targetFileId ? 'version.upload' : 'file.upload',
  );
  const folder = folderContext.folder;

  // Chunked uploads are assembled into the same quarantine object a single-shot
  // upload would have produced, so everything below has one code path.
  const quarantine = buildQuarantineKey({ uploadSessionId: physicalId(session.id) });
  let measuredSize = session.receivedBytes;
  let checksum = session.checksumSha256;

  if (session.chunkSize > 0) {
    const assembled = await assembleChunks(session);
    measuredSize = assembled.size;
    checksum = assembled.checksumSha256;
  }

  if (!(await storage.fileExists(quarantine.key, quarantine.area))) {
    throw new ConflictError('No uploaded content was received for this upload');
  }
  if (measuredSize === 0) {
    throw new ValidationError('The uploaded file is empty');
  }
  if (!checksum) {
    throw new ConflictError('The upload was not completed');
  }

  // The size the server measured is authoritative. A mismatch with the declaration is
  // a rejected upload, not a corrected record.
  if (session.declaredSize > 0 && measuredSize !== session.declaredSize) {
    throw new ValidationError(
      `The upload is incomplete: ${measuredSize} bytes received of ${session.declaredSize} declared`,
    );
  }

  await assertQuota(actor, folder.departmentId, measuredSize);

  const head = await readHead(quarantine.key, quarantine.area, measuredSize);
  const verdict = verifySignature(session.extension, head);
  if (!verdict.ok) {
    await rejectSession(actor, session, verdict.reason, meta);
    throw new UnsupportedMediaTypeError(verdict.reason);
  }

  // Scanned while still in quarantine, before the move. An infected file therefore never
  // exists at a key any download endpoint could resolve — there is no window in which it
  // could be served, however briefly.
  const scan = await getMalwareScanner().scan(
    await storage.getFile(quarantine.key, quarantine.area),
    session.displayName,
  );
  const blocking = verdictBlocksContent(scan);
  if (blocking.blocked) {
    await rejectSession(actor, session, blocking.reason, meta);
    throw new UnsupportedMediaTypeError(blocking.reason);
  }

  const fileId = session.targetFileId ?? fileRepository.newId();
  const physicalName = newStorageId();
  const destination = buildOriginalKey({
    organizationId: folder.organizationId,
    departmentId: folder.departmentId,
    fileId,
    versionId: physicalName,
  });

  // The move is a rename inside the same volume: atomic, and it is the moment the file
  // stops being untrusted.
  await storage.moveFile(
    { key: quarantine.key, area: quarantine.area },
    { key: destination.key, area: destination.area },
  );

  try {
    const result = await withTransaction(async (dbSession) => {
      const isNewFile = !session.targetFileId;
      const versionNumber = isNewFile ? 1 : await versionRepository.nextVersionNumber(fileId);

      if (isNewFile) {
        await fileRepository.create(
          {
            id: fileId,
            organizationId: folder.organizationId,
            displayName: session.displayName,
            originalFilename: session.declaredFilename,
            extension: session.extension,
            category: categoryFor(session.extension),
            folderId: folder.id,
            folderPathAncestors: [...folder.pathAncestors, folder.id],
            driveType: folder.driveType,
            ownerId: folder.driveType === 'my' ? folder.ownerId : actor.userId,
            departmentId: folder.departmentId,
            projectId: folder.projectId,
            confidentiality: folder.confidentiality,
            sizeBytes: measuredSize,
            mimeType: session.resolvedMimeType,
            checksumSha256: checksum,
            createdBy: actor.userId,
          },
          dbSession,
        );
      }

      const version = await versionRepository.create(
        {
          organizationId: folder.organizationId,
          fileId,
          versionNumber,
          storageKey: destination.key,
          storageArea: destination.area,
          relativeStoragePath: `${destination.area}/${destination.key}`,
          storedFilename: physicalName,
          originalFilename: session.declaredFilename,
          fileSize: measuredSize,
          mimeType: session.resolvedMimeType,
          extension: session.extension,
          checksumSha256: checksum,
          uploadedBy: actor.userId,
          ...(session.versionNote ? { versionNote: session.versionNote } : {}),
        },
        dbSession,
      );

      await versionRepository.setCurrent(fileId, version.id, dbSession);
      await fileRepository.updateById(
        fileId,
        {
          $set: {
            currentVersionId: version.id,
            sizeBytes: measuredSize,
            mimeType: session.resolvedMimeType,
            checksumSha256: checksum,
            originalFilename: session.declaredFilename,
            updatedBy: actor.userId,
            // A new version resets the review cycle: an approved file that changes is
            // no longer an approved file (docs/phase-0/05, versioning rules).
            ...(isNewFile ? {} : { reviewStatus: 'draft', approvalStatus: 'none' }),
          },
          $inc: { versionCount: 1 },
        },
        dbSession,
      );

      if (isNewFile) {
        await folderRepository.updateById(folder.id, { $inc: { fileCount: 1 } }, dbSession);
      } else {
        // A review in flight is a review of bytes that are no longer current. Leaving it
        // open would let a reviewer approve superseded content and have the file show an
        // approval badge for a version nobody signed.
        await reviewRepository.cancelOpenForFile(fileId, undefined, dbSession);
      }

      await usageRepository.applyDelta(
        {
          userId: actor.userId,
          departmentId: folder.departmentId,
          projectId: folder.projectId,
          bytes: measuredSize,
        },
        dbSession,
      );

      await sessionRepository.update(
        session.id,
        {
          $set: {
            status: 'ready',
            receivedBytes: measuredSize,
            checksumSha256: checksum,
            quarantineKey: null,
            resultFileId: fileId,
            resultVersionId: version.id,
          },
        },
        dbSession,
      );

      return { version, versionNumber, isNewFile };
    });

    await auditService.recordForActor(actor, meta, {
      action: result.isNewFile ? 'file.upload' : 'file.version_upload',
      entityType: 'file',
      entityId: fileId,
      entityLabel: session.displayName,
      newValue: {
        versionNumber: result.versionNumber,
        sizeBytes: measuredSize,
        checksumSha256: checksum,
        folderId: folder.id,
      },
      severity: 'notice',
    });

    void activityRepository
      .append({
        organizationId: folder.organizationId,
        actorUserId: actor.userId,
        actorName: actor.name,
        action: result.isNewFile ? 'file.upload' : 'file.version_upload',
        entityType: 'file',
        entityId: fileId,
        entityLabel: session.displayName,
        contextFolderIds: [...folder.pathAncestors, folder.id],
        departmentId: folder.departmentId,
        projectId: folder.projectId,
        detail: { versionNumber: result.versionNumber, sizeBytes: measuredSize },
      })
      .catch(() => undefined);

    await cleanupChunks(session);

    /**
     * Hand the file on to Google Drive, if that is where new content belongs.
     *
     * Deliberately **after** the transaction has committed. Everything above has already
     * made this a complete, readable, downloadable file backed by local storage — the same
     * state every pre-migration file is in — so nothing below can fail the upload. A Drive
     * outage leaves a queue, not a broken application.
     *
     * Bytes reach Drive from `originals`, never from quarantine: the signature check and
     * the malware scan both read the content back before it is trusted, and putting an
     * unscanned file at a real Drive id — visible in the Drive web UI, syncable to
     * desktops, indexable — during the scan window is exactly what decision D1 refuses.
     */
    await handOffToDrive({
      versionId: result.version.id,
      fileId,
      folderId: folder.id,
      displayName: session.displayName,
      organizationId: folder.organizationId,
      sizeBytes: measuredSize,
    });

    return {
      fileId,
      versionId: result.version.id,
      versionNumber: result.versionNumber,
      displayName: session.displayName,
      sizeBytes: measuredSize,
      checksumSha256: checksum,
      isNewFile: result.isNewFile,
    };
  } catch (error) {
    // The bytes are already in place but no record points at them: remove them, or the
    // volume slowly fills with files nothing can ever reference.
    await storage.deleteFile(destination.key, destination.area).catch(() => undefined);
    throw error;
  }
}

/**
 * Sends a freshly stored file on to Google Drive, or queues it to go later.
 *
 * **This function cannot fail the upload.** Every path through it either succeeds, queues,
 * or logs — the file is already complete and readable by the time it is called, and making
 * an employee's ability to save their work depend on Google being reachable would be a
 * worse product than one that occasionally takes a few minutes to finish tidying up.
 *
 * Small files transfer inline so the common case leaves nothing on the queue at all. Large
 * ones are queued, because holding an HTTP request open for a multi-gigabyte server→Drive
 * transfer would exceed the platform's 300-second ceiling — a latency decision, not a
 * correctness one. Either way the transfer itself is Phase 5's, unchanged.
 */
async function handOffToDrive(input: {
  versionId: string;
  fileId: string;
  folderId: string;
  displayName: string;
  organizationId: string;
  sizeBytes: number;
}): Promise<void> {
  const env = getEnv();

  // Not the registry default — the *configured* one. A deployment that has Drive connected
  // but has not yet switched new uploads over keeps writing locally, which is the whole
  // point of having the two settings separate.
  if (!isDriveStorageEnabled() || env.DEFAULT_STORAGE_PROVIDER !== 'google_drive') return;

  try {
    await queueForDrive(input.versionId);

    if (input.sizeBytes > env.uploadDriveSyncThresholdBytes) {
      // Queued only. A scheduled drain picks it up; the file works from local storage in
      // the meantime and the employee is told nothing, because nothing is wrong.
      return;
    }

    const store = requireDriveStore();
    const hierarchy = storageRegistry.hierarchy('google_drive');
    const { client } = getGoogleDriveStorage();

    const outcome = await transferVersion(
      {
        versionId: input.versionId,
        fileId: input.fileId,
        folderId: input.folderId,
        displayName: input.displayName,
        organizationId: input.organizationId,
        idempotencyKey: `upload:${input.versionId}`,
        jobId: null,
      },
      { store, client, hierarchy },
    );

    if (outcome.status === 'failed') {
      // Stays queued and stays local. The next drain retries it, and the file has been
      // readable throughout.
      getLogger().warn(
        { versionId: input.versionId, code: outcome.code, detail: outcome.detail },
        'Upload stored locally; the transfer to Google Drive will be retried',
      );
    }
  } catch (error) {
    getLogger().error(
      { versionId: input.versionId, err: error },
      'Upload stored locally; handing it to Google Drive failed and it remains queued',
    );
  }
}

/* ------------------------------------------------------------------ abort */

export async function abort(actor: Actor, sessionId: string): Promise<void> {
  const session = await sessionRepository.findById(sessionId);
  if (!session || session.userId !== actor.userId) throw new NotFoundError();
  if (session.status === 'ready') {
    throw new ConflictError('This upload has already completed');
  }

  await discardBytes(session);
  await sessionRepository.update(sessionId, {
    $set: { status: 'aborted', quarantineKey: null },
  });
}

export async function getStatus(
  actor: Actor,
  sessionId: string,
): Promise<sessionRepository.UploadSessionRecord> {
  const session = await sessionRepository.findById(sessionId);
  if (!session || session.userId !== actor.userId) throw new NotFoundError();
  return session;
}

/**
 * Removes abandoned uploads and the bytes they were holding.
 *
 * Bytes first, record second: the record is the only pointer to the quarantined file,
 * so deleting it first would strand the data with nothing left to find it by.
 */
export async function cleanupExpired(): Promise<{ sessions: number }> {
  const expired = await sessionRepository.listExpired(new Date());
  if (expired.length === 0) return { sessions: 0 };

  for (const session of expired) {
    await discardBytes(session);
  }
  const removed = await sessionRepository.remove(expired.map((session) => session.id));
  return { sessions: removed };
}

/* ---------------------------------------------------------------- helpers */

async function requireOwnSession(
  actor: Actor,
  sessionId: string,
  allowedStatuses: string[],
): Promise<sessionRepository.UploadSessionRecord> {
  const session = await sessionRepository.findById(sessionId);
  // Another user's session is reported as missing, not forbidden: session ids are
  // otherwise an oracle for what colleagues are uploading.
  if (!session || session.userId !== actor.userId) throw new NotFoundError();
  if (session.expiresAt.getTime() < Date.now()) {
    throw new ConflictError('This upload has expired. Start it again.', 'UPLOAD_SESSION_EXPIRED');
  }
  if (!allowedStatuses.includes(session.status)) {
    throw new ConflictError(`This upload is ${session.status} and cannot accept more data`);
  }
  return session;
}

async function assertQuota(
  actor: Actor,
  departmentId: string | null,
  bytes: number,
): Promise<void> {
  const userQuota = await usageRepository.getUserQuota(actor.userId);
  if (userQuota && userQuota.remainingBytes < bytes) {
    throw new QuotaExceededError(
      'This upload would exceed your personal storage quota. Delete something or ask an administrator to raise it.',
    );
  }

  if (departmentId) {
    const departmentQuota = await usageRepository.getDepartmentQuota(departmentId);
    if (departmentQuota && departmentQuota.remainingBytes < bytes) {
      throw new QuotaExceededError('This upload would exceed the department storage quota.');
    }
  }
}

/** Refuses an upload that would take the volume below its configured free-space floor. */
async function assertDiskHeadroom(bytes: number): Promise<void> {
  const env = getEnv();
  const capacity = await getStorageProvider().getCapacity('originals');
  if (capacity.freeBytes - bytes < env.minFreeDiskBytes) {
    getLogger().error(
      { freeBytes: capacity.freeBytes, requiredBytes: bytes },
      'Refusing upload: server storage is below the free-space floor',
    );
    throw new ServiceUnavailableError(
      'The server is low on storage. An administrator has been alerted; try again later.',
    );
  }
}

/**
 * A new file gets a non-colliding name; a new *version* keeps the file's existing name,
 * because a version is the same document, not a second one.
 */
async function resolveDisplayName(
  folderId: string,
  filename: string,
  isNewVersion: boolean,
): Promise<string> {
  const base = sanitizeDisplayName(filename) || 'untitled';
  if (isNewVersion) return base;
  const taken = await fileRepository.takenNamesInFolder(folderId);
  return nextAvailableName(base, taken);
}

/** Physical ids must be filesystem-safe; storage keys never contain a Mongo id verbatim. */
function physicalId(sessionId: string): string {
  return sessionId;
}

/**
 * Reads the first bytes of a quarantined object for signature checking.
 *
 * The range is clamped to the object's own size: the storage provider treats a range
 * ending past EOF as a programming error rather than clamping it (which is the right
 * default for an internal contract), so asking for 4 KB of a 20-byte CSV would fail the
 * upload rather than inspect it.
 */
async function readHead(key: string, area: StorageArea, size: number): Promise<Buffer> {
  const end = Math.min(SIGNATURE_SAMPLE_BYTES, size) - 1;
  if (end < 0) return Buffer.alloc(0);

  const stream = await getStorageProvider().getFile(key, area, {
    range: { start: 0, end },
  });
  const chunks: Buffer[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength >= SIGNATURE_SAMPLE_BYTES) break;
  }
  return Buffer.concat(chunks).subarray(0, SIGNATURE_SAMPLE_BYTES);
}

/**
 * Concatenates the received chunks into one quarantined object.
 *
 * Streamed chunk by chunk rather than buffered: a 2 GB resumable upload must not need
 * 2 GB of server memory to be assembled.
 */
async function assembleChunks(
  session: sessionRepository.UploadSessionRecord,
): Promise<{ size: number; checksumSha256: string }> {
  const missing = [];
  for (let index = 0; index < session.totalChunks; index += 1) {
    if (!session.receivedChunks.includes(index)) missing.push(index);
  }
  if (missing.length > 0) {
    throw new ConflictError(
      `The upload is missing ${missing.length} chunk(s). Resume it before finalizing.`,
    );
  }

  const storage = getStorageProvider();
  const quarantine = buildQuarantineKey({ uploadSessionId: physicalId(session.id) });
  await storage.deleteFile(quarantine.key, quarantine.area).catch(() => undefined);

  const handle = await storage.createWriteStream(quarantine.key, quarantine.area);
  const hash = createHash('sha256');
  let size = 0;

  try {
    for (let index = 0; index < session.totalChunks; index += 1) {
      const chunkKey = buildTemporaryChunkKey({
        uploadSessionId: physicalId(session.id),
        chunkIndex: index,
      });
      const stream = await storage.getFile(chunkKey.key, chunkKey.area);
      for await (const piece of stream as unknown as AsyncIterable<Buffer>) {
        const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
        hash.update(buffer);
        size += buffer.byteLength;
        await handle.write(buffer);
      }
    }
    await handle.commit();
  } catch (error) {
    await handle.abort().catch(() => undefined);
    throw error;
  }

  const checksumSha256 = hash.digest('hex');
  await sessionRepository.update(session.id, {
    $set: { receivedBytes: size, checksumSha256, quarantineKey: quarantine.key },
  });
  return { size, checksumSha256 };
}

async function cleanupChunks(session: sessionRepository.UploadSessionRecord): Promise<void> {
  if (session.chunkSize <= 0) return;
  const storage = getStorageProvider();
  for (let index = 0; index < session.totalChunks; index += 1) {
    const chunkKey = buildTemporaryChunkKey({
      uploadSessionId: physicalId(session.id),
      chunkIndex: index,
    });
    await storage.deleteFile(chunkKey.key, chunkKey.area).catch(() => undefined);
  }
}

async function discardBytes(session: sessionRepository.UploadSessionRecord): Promise<void> {
  const storage = getStorageProvider();
  const quarantine = buildQuarantineKey({ uploadSessionId: physicalId(session.id) });
  await storage.deleteFile(quarantine.key, quarantine.area).catch(() => undefined);
  await cleanupChunks(session);
}

async function failSession(sessionId: string, reason: string): Promise<void> {
  // Does not overwrite a session that was already rejected or completed: a file refused
  // for its content must stay `rejected` so the quarantine review can find it, even
  // though the refusal also propagates as a thrown error through this path.
  await sessionRepository.markFailed(sessionId, reason).catch(() => undefined);
}

async function rejectSession(
  actor: Actor,
  session: sessionRepository.UploadSessionRecord,
  reason: string,
  meta: RequestMeta,
): Promise<void> {
  await discardBytes(session);
  await sessionRepository.update(session.id, {
    $set: { status: 'rejected', failureReason: reason.slice(0, 500), quarantineKey: null },
  });

  await auditService.recordForActor(actor, meta, {
    action: 'upload.rejected',
    entityType: 'upload_session',
    entityId: session.id,
    entityLabel: session.displayName,
    newValue: { reason, extension: session.extension },
    outcome: 'denied',
    severity: 'warning',
  });
}

async function describeExistingResult(
  fileId: string,
  versionId: string,
): Promise<FinalizedUpload> {
  const [file, version] = await Promise.all([
    fileRepository.findById(fileId),
    versionRepository.findById(versionId),
  ]);
  if (!file || !version) throw new NotFoundError();

  return {
    fileId,
    versionId,
    versionNumber: version.versionNumber,
    displayName: file.displayName,
    sizeBytes: version.fileSize,
    checksumSha256: version.checksumSha256,
    isNewFile: version.versionNumber === 1,
  };
}

export const uploadService = {
  authorizeUpload,
  receiveStream,
  receiveChunk,
  finalize,
  abort,
  getStatus,
  cleanupExpired,
};
