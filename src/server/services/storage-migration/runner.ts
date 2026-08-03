/**
 * Driving a migration job to completion, or to a clean stop.
 *
 * Bounded concurrency, and the bound is not a performance knob — it is a courtesy to the
 * people using the application. Drive's per-project quota is shared between this migration
 * and every interactive upload and download, so a migration that saturated it would stop
 * employees working. `GOOGLE_DRIVE_MAX_CONCURRENT_TRANSFERS` (default 4) is the ceiling, and
 * a rate-limit response pauses the whole job for a cooldown rather than retrying tightly:
 * interactive traffic wins.
 *
 * Pause is cooperative and checked between items, never mid-transfer. Tearing a running
 * upload in half to honour a pause a few seconds sooner would leave a partial object and an
 * open recovery row for no benefit.
 */
import { getEnv } from '@/server/config/env';
import { getLogger } from '@/server/logging/logger';
import * as migrationRepository from '@/server/repositories/storage-migration.repository';
import type { ItemRecord } from '@/server/repositories/storage-migration.repository';
import { getObjectStore } from '@/server/storage';
import type { StorageArea } from '@/server/storage/types';
import { transferItem, type TransferDeps } from './transfer';

export interface RunOptions {
  jobId: string;
  workerId: string;
  deps: TransferDeps;
  /** Also claim items that previously failed. Used by an explicit retry run. */
  retryFailed?: boolean;
  /** Stop after this many items. Used by tests and by a bounded first batch. */
  maxItems?: number;
  /** Injected so tests do not actually wait out a rate-limit cooldown. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunSummary {
  verified: number;
  skipped: number;
  failed: number;
  bytes: number;
  stoppedBecause: 'complete' | 'paused' | 'cancelled' | 'limit' | 'rate_limited';
}

/** How long the whole job stands down after Drive says we are going too fast. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/**
 * A claim older than this belonged to a worker that died. Generous, because the ceiling is
 * a genuinely large file over a slow uplink — releasing a live claim early would let a
 * second worker start the same transfer.
 */
const STALE_CLAIM_MS = 30 * 60_000;

export async function runJob(options: RunOptions): Promise<RunSummary> {
  const env = getEnv();
  const log = getLogger().child({ jobId: options.jobId, workerId: options.workerId });
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Anything a crashed worker left claimed is released first, or its versions would be
  // permanently blocked by the unique index that exists to protect them.
  const released = await migrationRepository.releaseStaleClaims(
    options.jobId,
    new Date(Date.now() - STALE_CLAIM_MS),
  );
  if (released > 0) log.warn({ released }, 'Released claims abandoned by a previous run');

  await migrationRepository.updateJob(options.jobId, {
    $set: { status: 'running', startedAt: new Date(), lastError: null, pauseRequested: false },
  });

  const summary: RunSummary = {
    verified: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
    stoppedBecause: 'complete',
  };

  let processed = 0;
  let stop: RunSummary['stoppedBecause'] | null = null;

  /** One worker: claim, transfer, record, repeat until there is nothing left or a stop. */
  const worker = async (slot: number): Promise<void> => {
    for (;;) {
      if (stop) return;

      const job = await migrationRepository.findJob(options.jobId);
      if (!job) return;
      if (job.cancelRequested) {
        stop = 'cancelled';
        return;
      }
      if (job.pauseRequested) {
        stop = 'paused';
        return;
      }
      if (options.maxItems !== undefined && processed >= options.maxItems) {
        stop = 'limit';
        return;
      }

      const item = await migrationRepository.claimNextItem({
        jobId: options.jobId,
        workerId: `${options.workerId}:${slot}`,
        ...(options.retryFailed ? { retryFailed: true } : {}),
      });
      if (!item) return;

      processed += 1;
      await handleItem(item);
    }
  };

  const handleItem = async (item: ItemRecord): Promise<void> => {
    try {
      const outcome = await transferItem(item, options.deps);

      if (outcome.status === 'verified') {
        summary.verified += 1;
        summary.bytes += outcome.bytes;
        await migrationRepository.incrementCounters(options.jobId, {
          uploaded: 1,
          verified: 1,
          uploadedBytes: outcome.bytes,
        });
        return;
      }

      if (outcome.status === 'skipped') {
        summary.skipped += 1;
        await migrationRepository.releaseClaim(item.id, 'verified');
        await migrationRepository.incrementCounters(options.jobId, { skipped: 1 });
        return;
      }

      summary.failed += 1;
      await migrationRepository.failItem({
        itemId: item.id,
        code: outcome.code ?? 'UNKNOWN',
        detail: outcome.detail ?? 'The transfer failed',
      });
      await migrationRepository.incrementCounters(options.jobId, { failed: 1 }, outcome.code ?? 'UNKNOWN');

      // Drive is telling the whole project to slow down. Standing the job down is what
      // keeps interactive uploads working; retrying tightly would spend the shared quota.
      if (outcome.code === 'DRIVE_RATE_LIMITED' || outcome.code === 'DRIVE_QUOTA_EXCEEDED') {
        log.warn({ code: outcome.code }, 'Pausing the job after a Drive rate limit');
        stop = 'rate_limited';
        await sleep(RATE_LIMIT_COOLDOWN_MS);
      }
    } catch (error) {
      // An unexpected throw must not leave the item claimed forever — the unique index
      // would then block that version for good.
      summary.failed += 1;
      const detail = error instanceof Error ? error.message : 'Unexpected failure';
      log.error({ err: error, itemId: item.id }, 'Transfer threw unexpectedly');
      await migrationRepository.failItem({ itemId: item.id, code: 'UNKNOWN', detail });
      await migrationRepository.incrementCounters(options.jobId, { failed: 1 }, 'UNKNOWN');
    }
  };

  const slots = Math.max(1, env.GOOGLE_DRIVE_MAX_CONCURRENT_TRANSFERS);
  await Promise.all(Array.from({ length: slots }, (_, slot) => worker(slot)));

  summary.stoppedBecause = stop ?? 'complete';
  await finalizeJob(options.jobId, summary.stoppedBecause);
  return summary;
}

async function finalizeJob(jobId: string, stoppedBecause: RunSummary['stoppedBecause']): Promise<void> {
  const counts = await migrationRepository.countItemsByStatus(jobId);
  const outstanding = (counts.not_started ?? 0) + (counts.queued ?? 0);
  const failed = counts.failed ?? 0;

  if (stoppedBecause === 'cancelled') {
    await migrationRepository.updateJob(jobId, { $set: { status: 'cancelled', finishedAt: new Date() } });
    return;
  }
  if (stoppedBecause === 'paused' || stoppedBecause === 'limit' || stoppedBecause === 'rate_limited') {
    await migrationRepository.updateJob(jobId, {
      $set: {
        status: 'paused',
        pauseRequested: false,
        ...(stoppedBecause === 'rate_limited'
          ? { lastError: 'Paused automatically after Google Drive reported a rate limit.' }
          : {}),
      },
    });
    return;
  }

  // Nothing left to claim. `completed_with_failures` rather than `completed` when anything
  // failed: a job that reports success with forty failed items inside it is how failures
  // stop being looked at.
  await migrationRepository.updateJob(jobId, {
    $set: {
      status: outstanding > 0 ? 'paused' : failed > 0 ? 'completed_with_failures' : 'completed',
      finishedAt: outstanding > 0 ? null : new Date(),
    },
  });
}

/* ------------------------------------------------------------------ verify only */

/**
 * Re-checks already-migrated objects without moving anything.
 *
 * Metadata reads only — one `files.get` per item, no bytes. That is what makes it cheap
 * enough to run over a whole migrated corpus before authorising local deletion, which is
 * the point at which being wrong stops being recoverable.
 */
export async function verifyJob(options: {
  jobId: string;
  deps: TransferDeps;
  limit?: number;
}): Promise<{ checked: number; ok: number; failed: number }> {
  let checked = 0;
  let ok = 0;
  let failed = 0;
  let afterId: string | undefined;

  for (;;) {
    const items = await migrationRepository.listVerifiedItems(options.jobId, 200, afterId);
    if (items.length === 0) break;

    for (const item of items) {
      if (options.limit !== undefined && checked >= options.limit) return { checked, ok, failed };
      checked += 1;

      if (!item.googleDriveFileId) {
        failed += 1;
        await migrationRepository.failItem({
          itemId: item.id,
          code: 'VERIFY_MISMATCH',
          detail: 'The item is marked verified but records no Drive file',
        });
        continue;
      }

      try {
        const remote = await options.deps.client.getFile(item.googleDriveFileId);
        const remoteMd5 = remote.md5Checksum?.toLowerCase() ?? null;
        const matches =
          Number(remote.size ?? 0) === item.sizeBytes &&
          (!item.localMd5 || remoteMd5 === item.localMd5.toLowerCase());

        if (matches) {
          ok += 1;
        } else {
          failed += 1;
          await migrationRepository.failItem({
            itemId: item.id,
            code: 'VERIFY_MISMATCH',
            detail: 'The object in Drive no longer matches what was uploaded',
          });
        }
      } catch (error) {
        failed += 1;
        await migrationRepository.failItem({
          itemId: item.id,
          code: 'VERIFY_MISMATCH',
          detail: error instanceof Error ? error.message : 'The object could not be read',
        });
      }
    }

    afterId = items[items.length - 1]!.id;
  }

  return { checked, ok, failed };
}

/* --------------------------------------------------------------------- rollback */

/**
 * Rollback is a field flip. **No data moves and nothing is deleted.**
 *
 * The version goes back to reading from the local copy that was never removed; the Drive
 * object is deliberately left in place, because deleting it would make the rollback itself
 * the destructive act. A reconciliation sweep or an administrator can clean it up later,
 * once the reason for rolling back is understood.
 *
 * This only works while the local copies are still there, which is why
 * `DELETE_LOCAL_AFTER_MIGRATION` defaults to false and why Phase 11 is gated on a tested
 * restore drill.
 */
export async function rollbackJob(jobId: string): Promise<{ rolledBack: number; skipped: number }> {
  const { Types } = await import('mongoose');
  const { FileVersionModel } = await import('@/server/db/models/file-version.model');
  const { refreshFileStorageMirror } = await import('./transfer');

  let rolledBack = 0;
  let skipped = 0;
  let afterId: string | undefined;

  for (;;) {
    const items = await migrationRepository.listVerifiedItems(jobId, 200, afterId);
    if (items.length === 0) break;

    for (const item of items) {
      const version = await FileVersionModel.findById(new Types.ObjectId(item.versionId))
        .select({ localCopyState: 1, storageKey: 1, storageArea: 1, archivedStorageKey: 1 })
        .lean<{
          localCopyState?: string;
          storageKey: string;
          storageArea: string;
          archivedStorageKey?: string | null;
        }>()
        .exec();

      // Refusing here is the whole safety property. A version whose local copy has been
      // deleted has nothing to roll back *to*, and flipping it to `local` would point the
      // record at bytes that are not there — turning a recoverable situation into data loss.
      const state = version ? (version.localCopyState ?? 'present') : 'deleted';
      if (!version || state === 'deleted') {
        skipped += 1;
        continue;
      }

      /**
       * An archived copy still counts, because archiving moved the bytes rather than
       * destroying them — that distinction is the entire reason archive and delete are two
       * actions. Rolling back therefore means putting them back at the address the version
       * has always had, *before* the record is flipped: a crash between the two leaves an
       * extra copy in the archive, which is harmless, whereas the reverse order would leave
       * the record pointing at an address with nothing at it.
       */
      if (state === 'archived') {
        if (!version.archivedStorageKey) {
          skipped += 1;
          continue;
        }
        try {
          const local = getObjectStore('local');
          const source = {
            provider: 'local' as const,
            key: version.archivedStorageKey,
            area: 'archives' as const,
          };
          const target = { key: version.storageKey, area: version.storageArea as StorageArea };

          if (!(await local.exists({ provider: 'local', ...target }))) {
            await local.copy(source, target);
          }
        } catch (error) {
          getLogger().error(
            { versionId: item.versionId, err: error },
            'Could not restore an archived local copy during rollback',
          );
          skipped += 1;
          continue;
        }
      }

      await FileVersionModel.updateOne(
        { _id: new Types.ObjectId(item.versionId) },
        {
          $set: {
            storageProvider: 'local',
            migrationStatus: 'rolled_back',
            syncStatus: 'not_required',
            localCopyEligibleForDeletionAt: null,
            // Back to `present` wherever it came from: the bytes are at the version's own
            // address again, so the archive entry no longer describes anything.
            localCopyState: 'present',
            archivedStorageKey: null,
            localCopyArchivedAt: null,
          },
        },
      ).exec();

      await refreshFileStorageMirror(item.fileId);
      await migrationRepository.updateItem(item.id, { status: 'rolled_back', claimActive: false });
      rolledBack += 1;
    }

    afterId = items[items.length - 1]!.id;
  }

  await migrationRepository.incrementCounters(jobId, { rolledBack });
  await migrationRepository.updateJob(jobId, {
    $set: { status: 'completed', finishedAt: new Date() },
  });

  return { rolledBack, skipped };
}
