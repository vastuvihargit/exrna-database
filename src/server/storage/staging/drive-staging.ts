/**
 * Google Shared Drive staging — the pipeline that works in a Worker.
 *
 * ── The shape, and how it differs from the local one ────────────────────────────────────
 *
 *     authorize → session
 *       → buffer the first 4 KB, signature-check, REJECT EARLY  (caller; peek-head.ts)
 *       → stream the body into a Drive resumable upload in a STAGING folder,
 *         hashing and counting in a passthrough as it goes
 *       → verify size and checksum against what the server measured
 *       → move staging → destination with `files.update` (addParents/removeParents:
 *         a metadata change, not a byte copy)
 *       → record
 *
 * The staging folder is a real Drive folder, stamped with our own `appFolderId` so a crashed
 * run's leftovers can be found rather than duplicated. It is not part of the mirrored tree that
 * employees browse, and — this is the property that matters — **no `file_versions` row points
 * at anything in it**. An object in staging is not reachable through any application route,
 * because every route resolves bytes through a version record. Application ACL remains
 * authoritative throughout; a Drive id is never a capability.
 *
 * ── The one honest divergence: chunked uploads pay for their checksum ───────────────────
 *
 * A single-shot upload is hashed in the passthrough and costs nothing extra. A **chunked**
 * upload cannot be: each chunk arrives in its own HTTP request, possibly on a different
 * isolate, and a SHA-256 state cannot be serialized between them. So `assemble` reads the
 * staged object back from Drive once to compute the digest.
 *
 * That was chosen over the alternatives deliberately. Trusting a client-supplied digest breaks
 * the rule that the checksum is what the *server* measured. Recording Drive's MD5 instead
 * changes what the column means and would silently diverge from every other version in the
 * database. Skipping verification for large files inverts the risk — those are the uploads most
 * worth verifying. One extra read is the price of keeping the invariant, and it is paid only on
 * the chunked path.
 *
 * ── Resumable sessions cross HTTP requests ──────────────────────────────────────────────
 *
 * The resumable session URI and the staged file id live on the upload session row
 * (`external_upload_uri`, `external_staged_id`; migration 0005), because neither can be
 * recomputed. A chunk that arrives at an offset Drive has already filled is accepted as a
 * no-op; one that would leave a hole is refused. That makes a client retry safe rather than
 * merely likely to work — the same property the migration transfer relies on.
 */
import { createHash } from 'crypto';

import { ConflictError, StorageError, ValidationError } from '@/server/errors/app-error';
import { getLogger } from '@/server/logging/logger';
import { ensureDriveFolderPath } from '@/server/services/storage-migration/folder-mirror';
import type { DriveClient, DriveFileResource } from '../google/drive-client';
import type { GoogleDriveObjectStore } from '../google/google-drive-object-store';
import { buildOriginalKey } from '../keys';
import type {
  PromotedObject,
  PromotionTarget,
  StagedContent,
  StagedOutcome,
  StagingHandles,
  StagingSession,
  UploadStagingBackend,
} from './types';

/**
 * The Drive folder unverified bytes live in.
 *
 * A fixed `appFolderId` rather than a per-upload folder: adoption is by stamped id, and one
 * stable id means an interrupted run reuses the folder instead of leaving one behind for every
 * crash. The leading dot is a convention for humans browsing the Shared Drive, nothing more —
 * Drive has no hidden files, so the protection is that nothing points into it, not that it is
 * out of sight.
 */
const STAGING_FOLDER_NAME = '.upload-staging';
const STAGING_APP_FOLDER_ID = 'system:upload-staging';

const DEFAULT_BINARY_MIME = 'application/octet-stream';

export interface DriveStagingDeps {
  client: DriveClient;
  store: GoogleDriveObjectStore;
}

export class DriveUploadStaging implements UploadStagingBackend {
  readonly provider = 'google_drive' as const;

  private stagingFolderId: string | null = null;

  constructor(private readonly deps: DriveStagingDeps) {}

  /**
   * Google enforces the Shared Drive's quota and reports an over-quota upload as a failure.
   * There is no cheap pre-flight query for remaining space, and a check that always passes
   * while looking like one that does not is worse than an absent one.
   */
  async assertHeadroom(): Promise<void> {
    return undefined;
  }

  /* ------------------------------------------------------------------ staging folder */

  private async stagingFolder(): Promise<string> {
    if (this.stagingFolderId) return this.stagingFolderId;
    const folder = await this.deps.store.ensureFolder({
      name: STAGING_FOLDER_NAME,
      parentExternalId: null,
      appFolderId: STAGING_APP_FOLDER_ID,
    });
    this.stagingFolderId = folder.externalId;
    return folder.externalId;
  }

  /**
   * The staged object's name in Drive is the *session id*, never the employee's filename.
   *
   * Two reasons, and both are the same reason the local keys are generated ids: a filename is
   * attacker-chosen text, and a staged object that already carries the final display name is
   * indistinguishable in the Drive UI from a verified one.
   */
  private stagedName(session: StagingSession): string {
    return `staged-${session.id}`;
  }

  /* -------------------------------------------------------------------- single shot */

  async receive(input: {
    session: StagingSession;
    body: NodeJS.ReadableStream;
  }): Promise<StagedOutcome> {
    const parentId = await this.stagingFolder();

    // `put` hashes MD5 and SHA-256 in one passthrough, compares the MD5 against Drive's own
    // `md5Checksum`, and deletes the remote object if the round trip did not verify. The
    // measured SHA-256 comes back on the result — never the caller's.
    const stored = await this.deps.store.put({
      target: {
        key: this.stagedName(input.session),
        area: 'quarantine',
        externalParentId: parentId,
        displayName: this.stagedName(input.session),
        contentType: input.session.resolvedMimeType || DEFAULT_BINARY_MIME,
      },
      body: input.body,
      ...(input.session.declaredSize > 0 ? { size: input.session.declaredSize } : {}),
      properties: { uploadSessionId: input.session.id },
    });

    if (!stored.externalId || !stored.checksumSha256) {
      throw new StorageError('STORAGE_ERROR', 'The staged upload returned no id or checksum');
    }

    return {
      size: stored.size,
      checksumSha256: stored.checksumSha256,
      handles: { externalStagedId: stored.externalId, quarantineKey: null },
    };
  }

  /* ----------------------------------------------------------------------- chunked */

  async receiveChunk(input: {
    session: StagingSession;
    chunkIndex: number;
    expectedOffset: number;
    chunk: Buffer;
  }): Promise<{ complete: StagedContent | null; handles: StagingHandles }> {
    const { session } = input;

    // Already finished: a retried final chunk must not append its bytes a second time.
    if (session.externalStagedId) return { complete: null, handles: {} };

    const handles: StagingHandles = {};
    let sessionUri = session.externalUploadUri;

    if (!sessionUri) {
      if (input.expectedOffset !== 0) {
        // The first chunk this server ever saw is not chunk zero. A resumable session can
        // only be opened at the start, so there is nothing to resume into.
        throw new ConflictError(
          'This upload has not been started. Send the first chunk before resuming.',
          'UPLOAD_SESSION_EXPIRED',
        );
      }
      sessionUri = await this.deps.client.beginResumableUpload({
        name: this.stagedName(session),
        parentId: await this.stagingFolder(),
        mimeType: session.resolvedMimeType || DEFAULT_BINARY_MIME,
        ...(session.declaredSize > 0 ? { size: session.declaredSize } : {}),
        appProperties: { uploadSessionId: session.id },
      });
      handles.externalUploadUri = sessionUri;
    }

    /**
     * Ask Drive what it holds before sending.
     *
     * Not an optimization. A chunk request that timed out *after* Drive committed it looks
     * exactly like one that never arrived, and replaying at the wrong offset corrupts the
     * object. The session's own cursor is the only authority on which of the two happened.
     */
    const status = await this.deps.client.queryResumableUpload(
      sessionUri,
      session.declaredSize > 0 ? session.declaredSize : undefined,
    );

    if (status.file) {
      handles.externalStagedId = status.file.id;
      return { complete: null, handles };
    }

    // Bytes Drive already has. Accepting silently is what makes a client retry idempotent.
    if (status.receivedBytes >= input.expectedOffset + input.chunk.byteLength) {
      return { complete: null, handles };
    }
    if (status.receivedBytes !== input.expectedOffset) {
      throw new ConflictError(
        `This upload holds ${status.receivedBytes} bytes; resume from that offset rather than ${input.expectedOffset}.`,
      );
    }

    const result = await this.deps.client.putResumableChunk({
      sessionUri,
      chunk: input.chunk,
      offset: input.expectedOffset,
      ...(session.declaredSize > 0 ? { totalBytes: session.declaredSize } : {}),
    });

    if (result) {
      handles.externalStagedId = result.id;
      handles.externalUploadUri = null;
      // The digest is not known here — see the header. `assemble` computes it.
      return { complete: null, handles };
    }

    return { complete: null, handles };
  }

  /**
   * Confirms the staged object and measures it.
   *
   * Called for both paths. Single-shot uploads already know their digest and this re-derives
   * it; chunked ones have no other way to learn it. Both read the object back, so both get a
   * verification of what Drive actually holds rather than of what we believe we sent.
   */
  async assemble(session: StagingSession): Promise<StagedOutcome> {
    const stagedId = await this.requireStagedId(session);
    const remote = await this.deps.client.getFile(stagedId);

    const digest = await this.hashRemote(stagedId);
    const declaredRemoteSize = remote.size !== undefined ? Number(remote.size) : null;

    if (declaredRemoteSize !== null && declaredRemoteSize !== digest.size) {
      throw new StorageError(
        'STORAGE_ERROR',
        `Google Drive reports ${declaredRemoteSize} bytes for the staged upload but ${digest.size} were readable`,
      );
    }
    if (remote.md5Checksum && remote.md5Checksum.toLowerCase() !== digest.md5) {
      throw new StorageError(
        'STORAGE_ERROR',
        'The staged upload does not match the checksum Google Drive reports for it',
      );
    }

    return {
      size: digest.size,
      checksumSha256: digest.sha256,
      handles: { externalStagedId: stagedId, externalUploadUri: null },
    };
  }

  private async hashRemote(fileId: string): Promise<{ size: number; sha256: string; md5: string }> {
    const stream = await this.deps.client.downloadFile(fileId);
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    let size = 0;

    for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sha256.update(buffer);
      md5.update(buffer);
      size += buffer.byteLength;
    }

    return { size, sha256: sha256.digest('hex'), md5: md5.digest('hex') };
  }

  /* --------------------------------------------------------------------- inspection */

  async exists(session: StagingSession): Promise<boolean> {
    if (!session.externalStagedId) return false;
    return this.deps.store.itemExists(session.externalStagedId);
  }

  async readHead(session: StagingSession, bytes: number): Promise<Buffer> {
    const stagedId = await this.requireStagedId(session);
    const stream = await this.deps.client.downloadFile(stagedId, { start: 0, end: bytes - 1 });

    const chunks: Buffer[] = [];
    let collected = 0;
    for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      collected += buffer.byteLength;
      if (collected >= bytes) break;
    }
    return Buffer.concat(chunks, collected).subarray(0, bytes);
  }

  async openRead(session: StagingSession): Promise<NodeJS.ReadableStream> {
    const stagedId = await this.requireStagedId(session);
    return this.deps.client.downloadFile(stagedId);
  }

  /* ----------------------------------------------------------------------- promote */

  /**
   * Re-parents and renames the staged object. **No bytes move.**
   *
   * `files.update` with `addParents`/`removeParents` is a metadata change, so promoting a 4 GB
   * file costs one HTTP request. That is the whole reason staging is a Drive folder rather than
   * a second Drive file.
   *
   * The destination folder path is mirrored first, and the mirror is what can fail here — a
   * folder too deep for Drive, or a Drive outage. Failing before the re-parent leaves the object
   * in staging, which the cleanup sweep removes; failing after would leave a verified object in
   * the tree with no version row, which reconciliation reports.
   */
  async promote(session: StagingSession, target: PromotionTarget): Promise<PromotedObject> {
    const stagedId = await this.requireStagedId(session);
    const stagingParentId = await this.stagingFolder();

    const mirror = await ensureDriveFolderPath({
      folderId: target.folderId,
      hierarchy: this.deps.store,
    });

    const moved: DriveFileResource = await this.deps.client.updateFile(stagedId, {
      name: target.displayName,
      addParents: mirror.externalId,
      removeParents: stagingParentId,
    });

    // The local address is populated even though nothing is stored there — see `PromotedObject`.
    const local = buildOriginalKey({
      organizationId: target.organizationId,
      departmentId: target.departmentId,
      fileId: target.fileId,
      versionId: target.versionId,
    });

    return {
      provider: 'google_drive',
      key: local.key,
      area: local.area,
      externalId: moved.id,
      externalParentId: moved.parents?.[0] ?? mirror.externalId,
      ...(moved.headRevisionId ? { externalRevisionId: moved.headRevisionId } : {}),
      ...(moved.webViewLink ? { externalWebViewLink: moved.webViewLink } : {}),
      ...(moved.md5Checksum ? { checksumMd5: moved.md5Checksum } : {}),
    };
  }

  /**
   * Permanent deletion, not trashing.
   *
   * A rejected or abandoned upload must not sit in the Shared Drive's trash where it is
   * restorable and still counts against the drive's storage. This deletes objects this
   * application created and never recorded, which is the one case `deleteItem` is for.
   */
  async discard(session: StagingSession): Promise<void> {
    if (!session.externalStagedId) return;
    try {
      await this.deps.store.deleteItem(session.externalStagedId);
    } catch (error) {
      getLogger().warn(
        { uploadSessionId: session.id, err: error },
        'Could not remove a staged Drive object; the cleanup sweep will retry it',
      );
    }
  }

  private async requireStagedId(session: StagingSession): Promise<string> {
    if (session.externalStagedId) return session.externalStagedId;

    // A session with an open resumable URI but no staged id never finished. Asking Drive is
    // what distinguishes "the last response was lost" from "the client stopped sending".
    if (session.externalUploadUri) {
      const status = await this.deps.client.queryResumableUpload(
        session.externalUploadUri,
        session.declaredSize > 0 ? session.declaredSize : undefined,
      );
      if (status.file) return status.file.id;
    }

    throw new ConflictError('No uploaded content was received for this upload');
  }
}

/** Where a chunk starts, from the size agreed when the upload was authorized. */
export function offsetForChunk(chunkIndex: number, chunkSize: number): number {
  if (chunkSize <= 0) throw new ValidationError('This upload was not started as a chunked upload');
  return chunkIndex * chunkSize;
}
