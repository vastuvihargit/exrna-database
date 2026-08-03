/**
 * The queue of newly-uploaded files still waiting to reach Google Drive.
 *
 * ── Why an upload never blocks on Drive ────────────────────────────────────────────────
 *
 * A file is written to local storage, verified and recorded **before** Drive is involved at
 * all. At that moment it is a complete, readable, downloadable file backed by the local
 * provider — the same state every pre-migration file is in, which the whole of Phase 4
 * exists to serve. Moving it to Drive is then a separate step that can fail, retry, or wait
 * for a Google outage to end without anybody's upload failing.
 *
 * The alternative — hold the upload open until the bytes are in Drive — makes an employee's
 * ability to save their work depend on a third party being reachable, and makes a Drive
 * outage look like a broken application. The cost of this design is that local disk holds
 * pending files for longer during an outage, which is visible on the admin system page and
 * is the same disk those files would occupy for `LOCAL_COPY_RETENTION_DAYS` anyway.
 *
 * The transfer itself is Phase 5's, unchanged: the same verification, the same four
 * duplicate-prevention layers, the same recovery-row ordering. A parallel implementation for
 * uploads would be a second place for all of that to be subtly wrong.
 */
import { Types } from 'mongoose';

import { connectToDatabase } from '@/server/db/connection';
import { FileVersionModel } from '@/server/db/models/file-version.model';
import { FileModel } from '@/server/db/models/file.model';
import { getLogger } from '@/server/logging/logger';
import { transferVersion, type TransferDeps, type TransferTarget } from './transfer';

/**
 * Marks a version as wanting to be in Drive.
 *
 * `storageProvider` stays `local` — it describes where the bytes actually are, and they are
 * here. Only `migrationStatus` changes, which is the difference between "this belongs in
 * Drive" and "this is in Drive".
 */
export async function queueForDrive(versionId: string, reason?: string): Promise<void> {
  await connectToDatabase();
  await FileVersionModel.updateOne(
    { _id: new Types.ObjectId(versionId), storageProvider: { $in: ['local', null] } },
    {
      $set: {
        migrationStatus: 'queued',
        ...(reason ? { migrationFailureReason: reason.slice(0, 500) } : {}),
      },
    },
  ).exec();
}

export interface PendingTransfer extends TransferTarget {
  sizeBytes: number;
}

/**
 * Versions waiting to go to Drive, oldest first.
 *
 * Served by the `{ storageProvider, migrationStatus, _id }` index added in Phase 3 — the one
 * described there as "the migration worker's cursor", which is exactly what this is.
 */
export async function listPending(limit: number): Promise<PendingTransfer[]> {
  await connectToDatabase();

  const versions = await FileVersionModel.find({
    storageProvider: { $in: ['local', null] },
    migrationStatus: 'queued',
    processingStatus: 'ready',
  })
    .select({ fileId: 1, organizationId: 1, fileSize: 1 })
    .sort({ _id: 1 })
    .limit(limit)
    .lean<Array<{ _id: Types.ObjectId; fileId: Types.ObjectId; organizationId: Types.ObjectId; fileSize: number }>>()
    .exec();

  if (versions.length === 0) return [];

  const files = await FileModel.find({ _id: { $in: versions.map((v) => v.fileId) } })
    .select({ displayName: 1, folderId: 1 })
    .setOptions({ withDeleted: true })
    .lean<Array<{ _id: Types.ObjectId; displayName: string; folderId: Types.ObjectId }>>()
    .exec();
  const fileById = new Map(files.map((f) => [String(f._id), f]));

  const pending: PendingTransfer[] = [];
  for (const version of versions) {
    const file = fileById.get(String(version.fileId));
    // The file was purged between the two queries. Nothing to transfer it into.
    if (!file) continue;

    pending.push({
      versionId: String(version._id),
      fileId: String(version.fileId),
      folderId: String(file.folderId),
      displayName: file.displayName,
      organizationId: String(version.organizationId),
      // Stable for this version forever, so a retry adopts rather than duplicates. Prefixed
      // to keep it distinguishable from a migration job's `<jobId>:<versionId>`.
      idempotencyKey: `upload:${String(version._id)}`,
      jobId: null,
      sizeBytes: version.fileSize,
    });
  }

  return pending;
}

export async function countPending(): Promise<number> {
  await connectToDatabase();
  return FileVersionModel.countDocuments({
    storageProvider: { $in: ['local', null] },
    migrationStatus: 'queued',
  }).exec();
}

export interface DrainResult {
  transferred: number;
  failed: number;
  bytes: number;
}

/**
 * Moves as many pending versions to Drive as the limit allows.
 *
 * A failure leaves the version exactly as it was — local, readable, still queued — so the
 * next drain retries it. Nothing here can make a file worse than it already is, which is
 * the property that lets this run unattended.
 */
export async function drainPendingTransfers(input: {
  deps: TransferDeps;
  limit?: number;
}): Promise<DrainResult> {
  const log = getLogger();
  const pending = await listPending(input.limit ?? 25);
  const result: DrainResult = { transferred: 0, failed: 0, bytes: 0 };

  for (const target of pending) {
    try {
      const outcome = await transferVersion(target, input.deps);

      if (outcome.status === 'verified' || outcome.status === 'skipped') {
        result.transferred += 1;
        result.bytes += outcome.bytes;
      } else {
        result.failed += 1;
        log.warn(
          { versionId: target.versionId, code: outcome.code, detail: outcome.detail },
          'A queued upload could not be moved to Google Drive; it remains readable locally',
        );
      }
    } catch (error) {
      result.failed += 1;
      log.error(
        { versionId: target.versionId, err: error },
        'A queued upload threw while being moved to Google Drive',
      );
    }
  }

  return result;
}
