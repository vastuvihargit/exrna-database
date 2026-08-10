/**
 * Upload sessions — the shape both engines implement.
 *
 * A session is the server's record of an upload in flight: what was authorized, how much has
 * arrived, and what it became. Two of its operations are **concurrency controls rather than
 * writes**, and they are the reason this repository is more than CRUD.
 *
 * ── `claimForFinalization` is a lock, expressed as a status transition ──────────────────
 *
 * Only the request that moves a session out of `uploading`/`pending` gets to build the file. A
 * concurrent retry — a client that timed out and tried again — finds nothing to claim and reads
 * the already-stored result instead. That is what makes finalization idempotent, and it works
 * only because the transition is conditional inside one statement. A read-then-write would let
 * two requests both see `uploading` and both create a version.
 *
 * ── `markFailed` must not overwrite a decision ──────────────────────────────────────────
 *
 * `ready`, `rejected` and `aborted` are terminal. In particular a file *rejected for its
 * content* is a different thing from an upload that broke, and the admin review of quarantined
 * uploads needs to tell them apart — so the status filter is in the statement, not in a check
 * the caller performs first.
 *
 * ── The patch is typed, not a Mongo update document ─────────────────────────────────────
 *
 * `update` used to take `Record<string, unknown>` and every caller passed `{ $set: … }`, which
 * is a MongoDB operator D1 cannot honour. The patch is now a plain object of writable fields and
 * the Mongo implementation wraps it. Fields absent from `UploadSessionPatch` are absent
 * deliberately: nothing may rewrite the declared size, the folder or the owner of an upload that
 * has already been authorized.
 */
import type { ClientSession } from 'mongoose';
import type { UploadStatus } from '@/server/db/models';

export type { UploadStatus };

/** A Mongoose session on the Mongo path; ignored on D1. */
export type UploadSessionTx = ClientSession;

export interface UploadSessionRecord {
  id: string;
  organizationId: string;
  userId: string;
  folderId: string;
  targetFileId: string | null;
  declaredFilename: string;
  displayName: string;
  extension: string;
  declaredSize: number;
  declaredMimeType: string | null;
  resolvedMimeType: string;
  versionNote: string;
  status: UploadStatus;
  receivedBytes: number;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number[];
  quarantineKey: string | null;
  checksumSha256: string | null;
  resultFileId: string | null;
  resultVersionId: string | null;
  failureReason: string | null;
  finalizationKey: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateUploadSessionInput {
  organizationId: string;
  userId: string;
  folderId: string;
  targetFileId?: string | null;
  declaredFilename: string;
  displayName: string;
  extension: string;
  declaredSize: number;
  declaredMimeType?: string | null;
  resolvedMimeType: string;
  versionNote?: string;
  chunkSize?: number;
  totalChunks?: number;
  expiresAt: Date;
}

/**
 * What may change after authorization.
 *
 * The omissions are the point, and they are the *authorization* fields: `organizationId`,
 * `userId`, `folderId`, `targetFileId`, `declaredSize` and `declaredFilename`. Those were
 * decided by `authorizeUpload` against a permission check and a quota, and nothing downstream —
 * a chunk handler, a finalizer, a retry — may revise them. Making that a type error is cheaper
 * than making it a review comment.
 *
 * `expiresAt` and `totalChunks` are writable: extending a resumable upload's window and
 * adjusting the agreed chunk count are legitimate operations on a session that has already
 * passed its checks.
 */
export interface UploadSessionPatch {
  status?: UploadStatus;
  receivedBytes?: number;
  checksumSha256?: string | null;
  quarantineKey?: string | null;
  failureReason?: string | null;
  resultFileId?: string | null;
  resultVersionId?: string | null;
  totalChunks?: number;
  expiresAt?: Date;
}

export interface UploadSessionRepository {
  findById(id: string): Promise<UploadSessionRecord | null>;
  create(input: CreateUploadSessionInput): Promise<UploadSessionRecord>;
  update(
    id: string,
    patch: UploadSessionPatch,
    tx?: UploadSessionTx,
  ): Promise<UploadSessionRecord | null>;
  /** No-op when the session already reached a terminal state. */
  markFailed(id: string, reason: string): Promise<void>;
  /** Returns the session only to the caller that won the claim; null to everyone else. */
  claimForFinalization(id: string, finalizationKey: string): Promise<UploadSessionRecord | null>;
  /** Idempotent per chunk index: re-sending a chunk must not double-count its bytes. */
  recordChunk(id: string, chunkIndex: number, bytes: number): Promise<UploadSessionRecord | null>;
  listExpired(before: Date, limit?: number): Promise<UploadSessionRecord[]>;
  /** For the admin system page. */
  countByStatus(): Promise<Record<string, number>>;
  remove(ids: string[]): Promise<number>;
}

/** Statuses `markFailed` refuses to overwrite. */
export const TERMINAL_UPLOAD_STATUSES = ['ready', 'rejected', 'aborted'] as const;
/** Statuses a session can be claimed for finalization from. */
export const CLAIMABLE_UPLOAD_STATUSES = ['uploading', 'pending'] as const;
