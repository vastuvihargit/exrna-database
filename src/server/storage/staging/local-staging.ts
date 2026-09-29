/**
 * Local-disk staging — the pipeline that has been serving production, behind the interface.
 *
 * Nothing here is new. Quarantine keys, per-chunk temporary objects, the streamed assembly that
 * never buffers a whole file, the atomic same-volume rename into `originals` — all of it is the
 * code that was inline in `upload.service.ts`, moved so there can be a second implementation
 * beside it. The behaviour is intended to be byte-for-byte identical, and the Mongo suite is
 * what says whether it is.
 *
 * This backend is **not** loadable in a Worker, and that is correct: it is the local filesystem.
 * `getUploadStaging()` never selects it there.
 */
import { createHash } from 'crypto';
import { Readable } from 'stream';

import { ConflictError } from '@/server/errors/app-error';
import { getStorageProvider } from '../index';
import {
  buildOriginalKey,
  buildQuarantineKey,
  buildTemporaryChunkKey,
} from '../keys';
import type { StorageArea, StorageProvider } from '../types';
import { getEnv } from '@/server/config/env';
import { getLogger } from '@/server/logging/logger';
import { ServiceUnavailableError } from '@/server/errors/app-error';
import type {
  PromotedObject,
  PromotionTarget,
  StagedOutcome,
  StagingSession,
  UploadStagingBackend,
} from './types';

function provider(): StorageProvider {
  return getStorageProvider();
}

function quarantineRef(session: StagingSession): { key: string; area: StorageArea } {
  return buildQuarantineKey({ uploadSessionId: session.id });
}

function chunkRef(session: StagingSession, chunkIndex: number): { key: string; area: StorageArea } {
  return buildTemporaryChunkKey({ uploadSessionId: session.id, chunkIndex });
}

export class LocalUploadStaging implements UploadStagingBackend {
  readonly provider = 'local' as const;

  /** Refuses an upload that would take the volume below its configured free-space floor. */
  async assertHeadroom(bytes: number): Promise<void> {
    const env = getEnv();
    const capacity = await provider().getCapacity('originals');
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

  async receive(input: {
    session: StagingSession;
    body: NodeJS.ReadableStream;
  }): Promise<StagedOutcome> {
    const quarantine = quarantineRef(input.session);

    // The provider hashes and counts as it writes and aborts past `expectedSize`, so an
    // oversized or lying client is stopped mid-stream rather than after the disk has filled.
    const stored = await provider().saveFile({
      key: quarantine.key,
      area: quarantine.area,
      body: input.body,
      expectedSize: input.session.declaredSize,
      contentType: input.session.resolvedMimeType,
    });

    return {
      size: stored.size,
      checksumSha256: stored.checksumSha256,
      handles: { quarantineKey: quarantine.key },
    };
  }

  async receiveChunk(input: {
    session: StagingSession;
    chunkIndex: number;
    chunk: Buffer;
  }): Promise<{ complete: null; handles: Record<string, never> }> {
    const key = chunkRef(input.session, input.chunkIndex);

    // A retried chunk overwrites nothing: the previous attempt is removed first, so the
    // exclusive-create rule in the provider still holds.
    await provider().deleteFile(key.key, key.area).catch(() => undefined);
    await provider().saveFile({
      key: key.key,
      area: key.area,
      body: Readable.from(input.chunk),
      expectedSize: input.chunk.byteLength,
    });

    // Chunks live as separate objects until `assemble`; there is nothing complete to report.
    return { complete: null, handles: {} };
  }

  /**
   * Concatenates the received chunks into one quarantined object.
   *
   * Streamed chunk by chunk rather than buffered: a 2 GB resumable upload must not need 2 GB of
   * server memory to be assembled.
   */
  async assemble(session: StagingSession): Promise<StagedOutcome> {
    assertNoMissingChunks(session);

    const storage = provider();
    const quarantine = quarantineRef(session);
    await storage.deleteFile(quarantine.key, quarantine.area).catch(() => undefined);

    const handle = await storage.createWriteStream(quarantine.key, quarantine.area);
    const hash = createHash('sha256');
    let size = 0;

    try {
      for (let index = 0; index < session.totalChunks; index += 1) {
        const key = chunkRef(session, index);
        const stream = await storage.getFile(key.key, key.area);
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

    return {
      size,
      checksumSha256: hash.digest('hex'),
      handles: { quarantineKey: quarantine.key },
    };
  }

  async exists(session: StagingSession): Promise<boolean> {
    const quarantine = quarantineRef(session);
    return provider().fileExists(quarantine.key, quarantine.area);
  }

  /**
   * The range is clamped to the object's own size: the storage provider treats a range ending
   * past EOF as a programming error rather than clamping it (which is the right default for an
   * internal contract), so asking for 4 KB of a 20-byte CSV would fail the upload rather than
   * inspect it.
   */
  async readHead(session: StagingSession, bytes: number): Promise<Buffer> {
    const quarantine = quarantineRef(session);
    const metadata = await provider().getFileMetadata(quarantine.key, quarantine.area);
    const end = Math.min(bytes, metadata.size) - 1;
    if (end < 0) return Buffer.alloc(0);

    const stream = await provider().getFile(quarantine.key, quarantine.area, {
      range: { start: 0, end },
    });

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
    const quarantine = quarantineRef(session);
    return provider().getFile(quarantine.key, quarantine.area);
  }

  /** A rename inside the same volume: atomic, and the moment the file stops being untrusted. */
  async promote(session: StagingSession, target: PromotionTarget): Promise<PromotedObject> {
    const quarantine = quarantineRef(session);
    const destination = buildOriginalKey({
      organizationId: target.organizationId,
      departmentId: target.departmentId,
      fileId: target.fileId,
      versionId: target.versionId,
    });

    await provider().moveFile(
      { key: quarantine.key, area: quarantine.area },
      { key: destination.key, area: destination.area },
    );

    return { provider: 'local', key: destination.key, area: destination.area };
  }

  async discard(session: StagingSession): Promise<void> {
    const storage = provider();
    const quarantine = quarantineRef(session);
    await storage.deleteFile(quarantine.key, quarantine.area).catch(() => undefined);

    if (session.chunkSize <= 0) return;
    for (let index = 0; index < session.totalChunks; index += 1) {
      const key = chunkRef(session, index);
      await storage.deleteFile(key.key, key.area).catch(() => undefined);
    }
  }
}

export function assertNoMissingChunks(session: StagingSession): void {
  const missing: number[] = [];
  for (let index = 0; index < session.totalChunks; index += 1) {
    if (!session.receivedChunks.includes(index)) missing.push(index);
  }
  if (missing.length > 0) {
    throw new ConflictError(
      `The upload is missing ${missing.length} chunk(s). Resume it before finalizing.`,
    );
  }
}
