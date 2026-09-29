/**
 * The D1 upload-session repository.
 *
 * ── The two concurrency controls are conditional UPDATEs with RETURNING ─────────────────
 *
 * `claimForFinalization` and `markFailed` each carry their precondition in the WHERE clause:
 *
 *     UPDATE upload_sessions SET status = 'processing', finalization_key = ?
 *      WHERE id = ? AND status IN ('uploading','pending') AND finalization_key IS NULL
 *  RETURNING …
 *
 * SQLite serializes the two writers, so exactly one gets rows back. The loser gets an empty
 * `RETURNING` and knows it did not win — which is the whole idempotency story for a client that
 * retries on timeout. A `SELECT` followed by an `UPDATE` would let both see `uploading` and both
 * build a version.
 *
 * ── `recordChunk` cannot be `$addToSet`, and the difference matters ─────────────────────
 *
 * `received_chunks` is a JSON array column, and SQLite has no set-add operator. Adding the index
 * unconditionally would double-count a re-sent chunk's bytes, so the statement adds the index
 * *and* the bytes only when the index is not already present:
 *
 *     SET received_chunks = json_insert(received_chunks, '$[#]', ?),
 *         received_bytes  = received_bytes + ?
 *   WHERE ... AND NOT EXISTS (SELECT 1 FROM json_each(received_chunks) WHERE value = ?)
 *
 * Both halves are governed by the same predicate, in the same statement, so a duplicate chunk
 * changes nothing at all rather than changing one of the two. `json_each` is why the array can
 * stay a column instead of becoming a table for a value that is only ever read whole.
 *
 * A duplicate returns the session unchanged rather than null, because to the caller a chunk that
 * was already stored is a success.
 */
import { and, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { getD1 } from '@/server/db/d1-context';
import { inList } from '@/server/db/d1-bindings';
import { uploadSessions } from '@/server/db/schema/jobs';
import {
  CLAIMABLE_UPLOAD_STATUSES,
  TERMINAL_UPLOAD_STATUSES,
  type CreateUploadSessionInput,
  type UploadSessionPatch,
  type UploadSessionRecord,
  type UploadSessionRepository,
  type UploadStatus,
} from './upload-session.repository.contract';

interface SessionRow {
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
  status: string;
  receivedBytes: number;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: string;
  quarantineKey: string | null;
  externalUploadUri: string | null;
  externalStagedId: string | null;
  checksumSha256: string | null;
  resultFileId: string | null;
  resultVersionId: string | null;
  failureReason: string | null;
  finalizationKey: string | null;
  expiresAt: string;
  createdAt: string;
}

const recordColumns = {
  id: uploadSessions.id,
  organizationId: uploadSessions.organizationId,
  userId: uploadSessions.userId,
  folderId: uploadSessions.folderId,
  targetFileId: uploadSessions.targetFileId,
  declaredFilename: uploadSessions.declaredFilename,
  displayName: uploadSessions.displayName,
  extension: uploadSessions.extension,
  declaredSize: uploadSessions.declaredSize,
  declaredMimeType: uploadSessions.declaredMimeType,
  resolvedMimeType: uploadSessions.resolvedMimeType,
  versionNote: uploadSessions.versionNote,
  status: uploadSessions.status,
  receivedBytes: uploadSessions.receivedBytes,
  chunkSize: uploadSessions.chunkSize,
  totalChunks: uploadSessions.totalChunks,
  receivedChunks: uploadSessions.receivedChunks,
  quarantineKey: uploadSessions.quarantineKey,
  externalUploadUri: uploadSessions.externalUploadUri,
  externalStagedId: uploadSessions.externalStagedId,
  checksumSha256: uploadSessions.checksumSha256,
  resultFileId: uploadSessions.resultFileId,
  resultVersionId: uploadSessions.resultVersionId,
  failureReason: uploadSessions.failureReason,
  finalizationKey: uploadSessions.finalizationKey,
  expiresAt: uploadSessions.expiresAt,
  createdAt: uploadSessions.createdAt,
} as const;

function parseChunks(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : [];
  } catch {
    // A resumable upload with an unreadable chunk list is recoverable: the client re-sends
    // everything. Throwing would strand the session instead.
    return [];
  }
}

function toRecord(row: SessionRow): UploadSessionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    folderId: row.folderId,
    targetFileId: row.targetFileId,
    declaredFilename: row.declaredFilename,
    displayName: row.displayName,
    extension: row.extension,
    declaredSize: row.declaredSize,
    declaredMimeType: row.declaredMimeType,
    resolvedMimeType: row.resolvedMimeType,
    versionNote: row.versionNote ?? '',
    status: row.status as UploadStatus,
    receivedBytes: row.receivedBytes ?? 0,
    chunkSize: row.chunkSize ?? 0,
    totalChunks: row.totalChunks ?? 0,
    receivedChunks: parseChunks(row.receivedChunks),
    quarantineKey: row.quarantineKey,
    externalUploadUri: row.externalUploadUri,
    externalStagedId: row.externalStagedId,
    checksumSha256: row.checksumSha256,
    resultFileId: row.resultFileId,
    resultVersionId: row.resultVersionId,
    failureReason: row.failureReason,
    finalizationKey: row.finalizationKey,
    expiresAt: new Date(row.expiresAt),
    createdAt: new Date(row.createdAt),
  };
}

export async function findById(id: string): Promise<UploadSessionRecord | null> {
  const db = await getD1();
  const [row] = await db
    .select(recordColumns)
    .from(uploadSessions)
    .where(eq(uploadSessions.id, id))
    .limit(1);
  return row ? toRecord(row as SessionRow) : null;
}

export async function create(input: CreateUploadSessionInput): Promise<UploadSessionRecord> {
  const db = await getD1();
  const now = new Date().toISOString();

  const [row] = await db
    .insert(uploadSessions)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      folderId: input.folderId,
      targetFileId: input.targetFileId ?? null,
      declaredFilename: input.declaredFilename,
      displayName: input.displayName,
      extension: input.extension,
      declaredSize: input.declaredSize,
      declaredMimeType: input.declaredMimeType ?? null,
      resolvedMimeType: input.resolvedMimeType,
      versionNote: input.versionNote ?? '',
      status: 'pending',
      chunkSize: input.chunkSize ?? 0,
      totalChunks: input.totalChunks ?? 0,
      receivedChunks: '[]',
      expiresAt: input.expiresAt.toISOString(),
      createdAt: now,
      updatedAt: now,
    })
    .returning(recordColumns);

  return toRecord(row as SessionRow);
}

export async function update(
  id: string,
  patch: UploadSessionPatch,
): Promise<UploadSessionRecord | null> {
  const db = await getD1();

  // `expiresAt` is the one patch field that is a `Date` at the boundary and TEXT in the column.
  // Spreading the patch straight through would store `[object Date]`, and the comparison in
  // `listExpired` would then never match — an abandoned upload whose bytes are never cleaned up.
  const { expiresAt, ...rest } = patch;
  const [row] = await db
    .update(uploadSessions)
    .set({
      ...rest,
      ...(expiresAt !== undefined ? { expiresAt: expiresAt.toISOString() } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(uploadSessions.id, id))
    .returning(recordColumns);

  return row ? toRecord(row as SessionRow) : null;
}

export async function markFailed(id: string, reason: string): Promise<void> {
  const db = await getD1();

  // The terminal-status filter is in the statement, so a concurrent rejection cannot be
  // overwritten in the gap a read-then-write would leave.
  await db
    .update(uploadSessions)
    .set({
      status: 'failed',
      failureReason: reason.slice(0, 500),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(uploadSessions.id, id),
        sql`${uploadSessions.status} NOT IN (${sql.join(
          TERMINAL_UPLOAD_STATUSES.map((status) => sql`${status}`),
          sql`, `,
        )})`,
      ),
    );
}

export async function claimForFinalization(
  id: string,
  finalizationKey: string,
): Promise<UploadSessionRecord | null> {
  const db = await getD1();

  // Exactly one concurrent caller gets a row back. See the header.
  const [row] = await db
    .update(uploadSessions)
    .set({ status: 'processing', finalizationKey, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(uploadSessions.id, id),
        inArray(uploadSessions.status, [...CLAIMABLE_UPLOAD_STATUSES]),
        isNull(uploadSessions.finalizationKey),
      ),
    )
    .returning(recordColumns);

  return row ? toRecord(row as SessionRow) : null;
}

export async function recordChunk(
  id: string,
  chunkIndex: number,
  bytes: number,
): Promise<UploadSessionRecord | null> {
  const db = await getD1();

  // The index and the byte count move together, under one predicate — see the header.
  const [row] = await db
    .update(uploadSessions)
    .set({
      receivedChunks: sql`json_insert(${uploadSessions.receivedChunks}, '$[#]', ${chunkIndex})`,
      receivedBytes: sql`${uploadSessions.receivedBytes} + ${bytes}`,
      status: 'uploading',
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(uploadSessions.id, id),
        sql`NOT EXISTS (
          SELECT 1 FROM json_each(${uploadSessions.receivedChunks}) WHERE value = ${chunkIndex}
        )`,
      ),
    )
    .returning(recordColumns);

  // A duplicate chunk changed nothing; the session is still there and the caller succeeded.
  return row ? toRecord(row as SessionRow) : findById(id);
}

export async function listExpired(before: Date, limit = 200): Promise<UploadSessionRecord[]> {
  const db = await getD1();
  const rows = await db
    .select(recordColumns)
    .from(uploadSessions)
    .where(
      and(
        lte(uploadSessions.expiresAt, before.toISOString()),
        // A finished upload has no quarantine object left to clean up.
        ne(uploadSessions.status, 'ready'),
      ),
    )
    .limit(limit);

  return rows.map((row) => toRecord(row as SessionRow));
}

export async function countByStatus(): Promise<Record<string, number>> {
  const db = await getD1();
  const rows = await db
    .select({ status: uploadSessions.status, count: sql<number>`COUNT(*)` })
    .from(uploadSessions)
    .groupBy(uploadSessions.status);

  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.status) out[row.status] = Number(row.count);
  }
  return out;
}

export async function remove(ids: string[]): Promise<number> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return 0;

  const db = await getD1();
  const deleted = await db
    .delete(uploadSessions)
    .where(inList(uploadSessions.id, unique))
    .returning({ id: uploadSessions.id });

  return deleted.length;
}

export const d1UploadSessionRepository: UploadSessionRepository = {
  findById,
  create,
  update,
  markFailed,
  claimForFinalization,
  recordChunk,
  listExpired,
  countByStatus,
  remove,
};
