/**
 * Upload sessions — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_UPLOAD_SESSIONS`.
 *
 * Note what having a D1 implementation does *not* achieve on its own: the upload **pipeline**
 * still writes bytes to a local quarantine directory before Google Drive sees them, so a Worker
 * cannot upload regardless of this flag. See `docs/cloudflare-migration/16-phase-7-storage-audit.md`.
 * This repository is the metadata half of that work, finished ahead of the byte half.
 */
import { isD1 } from './data-source';
import { mongoUploadSessionRepository } from './upload-session.repository.mongo';
import { d1UploadSessionRepository } from './upload-session.repository.d1';
import type {
  CreateUploadSessionInput,
  UploadSessionPatch,
  UploadSessionRecord,
  UploadSessionRepository,
  UploadSessionTx,
  UploadStatus,
} from './upload-session.repository.contract';

export type {
  CreateUploadSessionInput,
  UploadSessionPatch,
  UploadSessionRecord,
  UploadSessionRepository,
  UploadSessionTx,
  UploadStatus,
};

export { mongoUploadSessionRepository, d1UploadSessionRepository };

function active(): UploadSessionRepository {
  return isD1('uploadSessions') ? d1UploadSessionRepository : mongoUploadSessionRepository;
}

export function findById(id: string): Promise<UploadSessionRecord | null> {
  return active().findById(id);
}

export function create(input: CreateUploadSessionInput): Promise<UploadSessionRecord> {
  return active().create(input);
}

export function update(
  id: string,
  patch: UploadSessionPatch,
  tx?: UploadSessionTx,
): Promise<UploadSessionRecord | null> {
  return active().update(id, patch, tx);
}

export function markFailed(id: string, reason: string): Promise<void> {
  return active().markFailed(id, reason);
}

export function claimForFinalization(
  id: string,
  finalizationKey: string,
): Promise<UploadSessionRecord | null> {
  return active().claimForFinalization(id, finalizationKey);
}

export function recordChunk(
  id: string,
  chunkIndex: number,
  bytes: number,
): Promise<UploadSessionRecord | null> {
  return active().recordChunk(id, chunkIndex, bytes);
}

export function listExpired(before: Date, limit = 200): Promise<UploadSessionRecord[]> {
  return active().listExpired(before, limit);
}

export function countByStatus(): Promise<Record<string, number>> {
  return active().countByStatus();
}

export function remove(ids: string[]): Promise<number> {
  return active().remove(ids);
}
