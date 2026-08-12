/**
 * Secure upload pipeline.
 *
 * The order matters and is the whole point (docs/phase-0/06-flows.md):
 *
 *   authorize → session → signature-check the head → stage → measure → scan → promote → record
 *
 * Nothing is accepted before permission, type and quota have been decided, the bytes never
 * touch the served tree, the size and checksum are what the server *measured* rather than what
 * the client claimed, and the metadata is written only once the bytes are safely in place. A
 * failure at any step leaves no half-file and no orphan record.
 *
 * ── What Phase 7 changed, and what it did not ───────────────────────────────────────────
 *
 * "Stage" used to be spelled `getStorageProvider()` — the local filesystem — in eight places,
 * which made this the one request path a Cloudflare Worker could not run. It is now an
 * `UploadStagingBackend`, chosen by `DEFAULT_STORAGE_PROVIDER`, with a local implementation
 * that is the pipeline that has been serving production and a Drive implementation that stages
 * into a resumable upload and promotes by re-parenting.
 *
 * Two things genuinely improved rather than merely moved:
 *
 *   • **The signature check runs before the body is staged at all.** The first 4 KB are
 *     buffered in memory and checked against the declared extension, so a mistyped or
 *     mislabelled file is refused before a byte is written or uploaded — rather than after it
 *     has been written to disk and read back.
 *   • **Drive is a destination, not a mirror.** `handOffToDrive` still exists and is unchanged,
 *     but it now runs only for uploads that were staged locally. Content staged in Drive is
 *     already there and is recorded as such; there is nothing to hand off.
 */
import { Readable } from 'stream';

import { getEnv } from '@/server/config/env';
import { withTransaction } from '@/server/db/connection';
import { createVersionWithFile, versionMutationEngine } from '@/server/db/d1-unit-of-work';
import {
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  QuotaExceededError,
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
import { getObjectStore, storageRegistry } from '@/server/storage';
import { getGoogleDriveStorage, isDriveStorageEnabled } from '@/server/storage/google';
import {
  getUploadStaging,
  offsetForChunk,
  peekHead,
  type PromotedObject,
  type StagingHandles,
  type StagingSession,
} from '@/server/storage/staging';
import { requireDriveStore, transferVersion } from './storage-migration/transfer';
import { queueForDrive } from './storage-migration/pending-transfers';
import { newStorageId } from '@/server/storage/keys';
import { extractExtension, sanitizeFilename } from '@/server/storage/path-safety';
import { getLogger } from '@/server/logging/logger';
import { getMalwareScanner, verdictBlocksContent } from '@/server/security/malware-scanner';
import type { RequestMeta } from '@/server/http/request-meta';
import { requireFolder } from './folder-access';
import { requireFile } from './file-access';

/**
 * Bytes inspected to check the file really is what it claims.
 *
 * Buffered from the front of the stream *before* staging, and read back from staging again at
 * finalization. Both, deliberately: the first refusal is cheap and stops a mislabelled file
 * being transferred at all, and the second is the gate — it inspects what was actually stored
 * rather than what was presented, which is the only version of the check a chunked upload can
 * have at all.
 */
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
  await assertStagingHeadroom(input.size);

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
 * The head is buffered and signature-checked first, so a mislabelled file is refused before a
 * byte is staged. The rest of the body is then streamed into the staging backend, which hashes
 * and counts as it goes and aborts past `expectedSize` — so an oversized or lying client is
 * stopped mid-stream rather than after the disk (or the Shared Drive) has filled.
 */
export async function receiveStream(
  actor: Actor,
  sessionId: string,
  body: Readable,
  meta: RequestMeta,
): Promise<{ receivedBytes: number; checksumSha256: string }> {
  const session = await requireOwnSession(actor, sessionId, ['pending', 'uploading']);
  const staging = getUploadStaging();

  // Before anything is staged. A .exe renamed to .csv is refused here, having cost one buffer
  // rather than a full transfer.
  const peeked = await peekHead(body, SIGNATURE_SAMPLE_BYTES);
  await assertSignature(actor, session, peeked.head, meta);

  try {
    const staged = await staging.receive({
      session: stagingView(session),
      body: peeked.body,
      displayName: session.displayName,
    });

    await sessionRepository.update(sessionId, {
      status: 'uploading',
      receivedBytes: staged.size,
      checksumSha256: staged.checksumSha256,
      ...staged.handles,
    });

    return { receivedBytes: staged.size, checksumSha256: staged.checksumSha256 };
  } catch (error) {
    await failSession(sessionId, error instanceof Error ? error.message : 'Upload failed');
    throw error;
  }
}

/**
 * One chunk of a resumable upload. Re-sending a chunk is safe and does not double-count.
 *
 * The chunk's byte offset is derived from the size agreed at authorization rather than taken
 * from the client, because on a provider-side resumable session the offset *is* the write
 * position: accepting a client-chosen one would let a caller write over bytes it had already
 * sent, or leave a hole the checksum would then be computed across.
 */
export async function receiveChunk(
  actor: Actor,
  sessionId: string,
  chunkIndex: number,
  chunk: Buffer,
  meta: RequestMeta,
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

  // The first chunk carries the head, so the cheap refusal is available here too.
  if (chunkIndex === 0) {
    await assertSignature(actor, session, chunk.subarray(0, SIGNATURE_SAMPLE_BYTES), meta);
  }

  const staged = await getUploadStaging().receiveChunk({
    session: stagingView(session),
    chunkIndex,
    expectedOffset: offsetForChunk(chunkIndex, session.chunkSize),
    chunk,
    displayName: session.displayName,
  });

  // Handles first: a crash between the provider accepting bytes and the session recording
  // where they went would strand them, with nothing left to find them by.
  if (hasHandles(staged.handles)) {
    await sessionRepository.update(sessionId, staged.handles);
  }

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
  const staging = getUploadStaging();
  const folderContext = await requireFolder(
    actor,
    session.folderId,
    session.targetFileId ? 'version.upload' : 'file.upload',
  );
  const folder = folderContext.folder;

  // Chunked uploads are assembled into the same single staged object a single-shot upload
  // would have produced, so everything below has one code path.
  let stagingSession = stagingView(session);
  let measuredSize = session.receivedBytes;
  let checksum = session.checksumSha256;

  if (session.chunkSize > 0) {
    const assembled = await staging.assemble(stagingSession);
    measuredSize = assembled.size;
    checksum = assembled.checksumSha256;
    stagingSession = applyHandles(stagingSession, assembled.handles);
    await sessionRepository.update(session.id, {
      receivedBytes: assembled.size,
      checksumSha256: assembled.checksumSha256,
      ...assembled.handles,
    });
  }

  if (!(await staging.exists(stagingSession))) {
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

  // Read back from staging — what was actually stored, not what was presented. For a chunked
  // upload this is the only signature check there can be, because the head arrived in its own
  // request before any of the rest existed.
  const head = await staging.readHead(stagingSession, Math.min(SIGNATURE_SAMPLE_BYTES, measuredSize));
  const verdict = verifySignature(session.extension, head);
  if (!verdict.ok) {
    await rejectSession(actor, session, verdict.reason, meta);
    throw new UnsupportedMediaTypeError(verdict.reason);
  }

  // Scanned while still staged, before the promotion. An infected file therefore never exists
  // at an address any download endpoint could resolve — every read path resolves bytes through
  // a version record, and no version record points into staging.
  const scan = await getMalwareScanner().scan(
    await staging.openRead(stagingSession),
    session.displayName,
  );
  const blocking = verdictBlocksContent(scan);
  if (blocking.blocked) {
    await rejectSession(actor, session, blocking.reason, meta);
    throw new UnsupportedMediaTypeError(blocking.reason);
  }

  const fileId = session.targetFileId ?? fileRepository.newId();
  const physicalName = newStorageId();

  // The moment the file stops being untrusted: a same-volume rename locally, a re-parent in
  // Drive. Either way no bytes are re-read and nothing is copied.
  const stored: PromotedObject = await staging.promote(stagingSession, {
    organizationId: folder.organizationId,
    departmentId: folder.departmentId,
    folderId: folder.id,
    fileId,
    versionId: physicalName,
    displayName: session.displayName,
    contentType: session.resolvedMimeType,
    sizeBytes: measuredSize,
  });

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

      const versionFields = {
        organizationId: folder.organizationId,
        fileId,
        storageKey: stored.key,
        storageArea: stored.area,
        relativeStoragePath: `${stored.area}/${stored.key}`,
        storedFilename: physicalName,
        originalFilename: session.declaredFilename,
        fileSize: measuredSize,
        mimeType: session.resolvedMimeType,
        extension: session.extension,
        // Measured while streaming the upload, never taken from the client.
        checksumSha256: checksum,
        uploadedBy: actor.userId,
        ...(session.versionNote ? { versionNote: session.versionNote } : {}),
        /**
         * Where the bytes actually are.
         *
         * For a locally-staged upload this is `local` and the Drive fields are absent, exactly
         * as before — `handOffToDrive` below may copy it later. For a Drive-staged upload the
         * bytes are already in the Shared Drive at a real id, and recording it as `local` would
         * make every subsequent read look for a file on a disk that does not exist.
         */
        storageProvider: stored.provider,
        ...(stored.externalId ? { googleDriveFileId: stored.externalId } : {}),
        ...(stored.externalParentId ? { googleDriveParentId: stored.externalParentId } : {}),
        ...(stored.externalRevisionId ? { googleDriveRevisionId: stored.externalRevisionId } : {}),
        ...(stored.externalWebViewLink ? { googleDriveWebViewLink: stored.externalWebViewLink } : {}),
        ...(stored.checksumMd5 ? { googleDriveMd5: stored.checksumMd5 } : {}),
      };

      const fileFields = {
        sizeBytes: measuredSize,
        mimeType: session.resolvedMimeType,
        checksumSha256: checksum,
        originalFilename: session.declaredFilename,
        updatedBy: actor.userId,
        // A new version resets the review cycle: an approved file that changes is
        // no longer an approved file (docs/phase-0/05, versioning rules).
        ...(isNewFile ? {} : { reviewStatus: 'draft' as const, approvalStatus: 'none' as const }),
        versionCountDelta: 1,
      };

      /**
       * On D1 the version row, `is_current`, and the file's `current_version_id` commit as one
       * batch — `withTransaction` is a MongoDB session and governs none of them. The version
       * number is assigned inside that batch against the unique index, so two uploads racing
       * on the same file cannot both take it.
       */
      const version =
        versionMutationEngine() === 'd1'
          ? await createVersionWithFile({ version: versionFields, file: fileFields }).then(
              async ({ versionId }) => {
                const stored = await versionRepository.findById(versionId);
                if (!stored) throw new NotFoundError();
                return stored;
              },
            )
          : await (async () => {
              const created = await versionRepository.create(
                { ...versionFields, versionNumber },
                dbSession,
              );
              await versionRepository.setCurrent(fileId, created.id, dbSession);
              await fileRepository.updateById(
                fileId,
                { ...fileFields, currentVersionId: created.id },
                dbSession,
              );
              return created;
            })();

      if (isNewFile) {
        await folderRepository.updateById(folder.id, { fileCountDelta: 1 }, dbSession);
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
          status: 'ready',
          receivedBytes: measuredSize,
          checksumSha256: checksum,
          // Cleared together. A staged handle left behind after promotion names an object the
          // file now points at, and the cleanup sweep would delete it.
          quarantineKey: null,
          externalUploadUri: null,
          externalStagedId: null,
          resultFileId: fileId,
          resultVersionId: version.id,
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

    await cleanupChunks(stagingSession);

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
    // Only for content that was staged locally. A Drive-staged upload is already in the Shared
    // Drive at the id just recorded; handing it off would look for a local file that was never
    // written and queue a transfer that can never succeed.
    if (stored.provider === 'local') {
      await handOffToDrive({
        versionId: result.version.id,
        fileId,
        folderId: folder.id,
        displayName: session.displayName,
        organizationId: folder.organizationId,
        sizeBytes: measuredSize,
      });
    }

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
    // The bytes are already in place but no record points at them: remove them, or storage
    // slowly fills with objects nothing can ever reference. The promoted object is addressed
    // by what `promote` returned, because it is no longer where staging left it.
    await removePromoted(stored).catch(() => undefined);
    throw error;
  }
}

/** Undoes a promotion whose database write failed. Best effort, and never throws. */
async function removePromoted(stored: PromotedObject): Promise<void> {
  const locator = {
    provider: stored.provider,
    key: stored.key,
    area: stored.area,
    ...(stored.externalId ? { externalId: stored.externalId } : {}),
  };
  await getObjectStore(stored.provider).remove(locator);
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
    status: 'aborted',
    quarantineKey: null,
    externalUploadUri: null,
    externalStagedId: null,
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

/**
 * Refuses an upload the staging backend has no room for.
 *
 * Delegated rather than inlined because "room" means different things: a free-space floor on a
 * local volume, and nothing checkable at all in Drive, where Google enforces the quota and
 * reports it as an upload failure. See `UploadStagingBackend.assertHeadroom`.
 */
async function assertStagingHeadroom(bytes: number): Promise<void> {
  await getUploadStaging().assertHeadroom(bytes);
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

/**
 * The narrow view of a session a staging backend is allowed to see.
 *
 * Staging has no business reading the actor, the destination folder or any of the fields
 * `authorizeUpload` decided against a permission check. Passing a projection rather than the
 * record is what stops it growing a second opinion about any of them.
 */
function stagingView(session: sessionRepository.UploadSessionRecord): StagingSession {
  return {
    id: session.id,
    resolvedMimeType: session.resolvedMimeType,
    declaredSize: session.declaredSize,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    receivedChunks: session.receivedChunks,
    quarantineKey: session.quarantineKey,
    externalUploadUri: session.externalUploadUri,
    externalStagedId: session.externalStagedId,
  };
}

/** `undefined` means "unchanged"; an explicit `null` clears. See `StagingHandles`. */
function applyHandles(session: StagingSession, handles: StagingHandles): StagingSession {
  return {
    ...session,
    ...(handles.quarantineKey !== undefined ? { quarantineKey: handles.quarantineKey } : {}),
    ...(handles.externalUploadUri !== undefined
      ? { externalUploadUri: handles.externalUploadUri }
      : {}),
    ...(handles.externalStagedId !== undefined
      ? { externalStagedId: handles.externalStagedId }
      : {}),
  };
}

function hasHandles(handles: StagingHandles): boolean {
  return (
    handles.quarantineKey !== undefined ||
    handles.externalUploadUri !== undefined ||
    handles.externalStagedId !== undefined
  );
}

/**
 * The early signature refusal, shared by both receive paths.
 *
 * Records the same `upload.rejected` audit event the finalization check does, because a refusal
 * that leaves no trace is indistinguishable from an upload nobody attempted — and the quarantine
 * review exists precisely to see attempts.
 */
async function assertSignature(
  actor: Actor,
  session: sessionRepository.UploadSessionRecord,
  head: Buffer,
  meta: RequestMeta,
): Promise<void> {
  // Nothing to inspect yet. A zero-length head is not a pass, it is an absent answer, and the
  // authoritative check at finalization reads what was actually stored.
  if (head.byteLength === 0) return;

  const verdict = verifySignature(session.extension, head);
  if (verdict.ok) return;

  await rejectSession(actor, session, verdict.reason, meta);
  throw new UnsupportedMediaTypeError(verdict.reason);
}

async function cleanupChunks(session: StagingSession): Promise<void> {
  if (session.chunkSize <= 0) return;
  // `discard` removes chunk objects as well as the assembled one, and the assembled one has
  // already been promoted away by the time this runs.
  await getUploadStaging()
    .discard({ ...session, quarantineKey: null, externalStagedId: null })
    .catch(() => undefined);
}

async function discardBytes(session: sessionRepository.UploadSessionRecord): Promise<void> {
  await getUploadStaging().discard(stagingView(session)).catch(() => undefined);
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
    status: 'rejected',
    failureReason: reason.slice(0, 500),
    quarantineKey: null,
    externalUploadUri: null,
    externalStagedId: null,
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
    // Internal: describing the upload this request just finalized, whose permission was
    // asserted when the session was opened.
    fileRepository.findByIdInternal(fileId),
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
