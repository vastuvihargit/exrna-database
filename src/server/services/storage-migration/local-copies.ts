/**
 * The last step of the migration, and the only irreversible one.
 *
 * Every version migrated to Drive keeps its local bytes. That retention is not caution for
 * its own sake — it *is* the rollback mechanism: reverting a version to local storage is a
 * single field change with no data movement, which only works while the bytes are still
 * there. §8 of the Phase 0 analysis rests on it, and so does Phase 4's fallback when a Drive
 * object goes missing.
 *
 * So removing them ends two guarantees at once, and this module is built around making that
 * deliberate rather than automatic.
 *
 * ── Archive and delete are different actions ───────────────────────────────────────────
 *
 *   **Archive** moves the bytes from `originals` into `archives` and records where they went.
 *   Nothing is lost. Rollback still works — it copies them back first. This is the step that
 *   gets an administrator most of the disk space back while keeping every safety property,
 *   and it is the one they should reach for.
 *
 *   **Delete** removes them. Rollback for that version stops being possible, and Phase 4's
 *   fallback for a missing Drive object stops being possible. It is a distinct action, with a
 *   distinct audit entry, gated on a distinct environment flag, and it is refused unless the
 *   object is verifiably in Drive *at that moment* — not merely recorded as verified weeks
 *   ago by a job whose result nobody has re-checked.
 *
 * ── Five conditions, all required ──────────────────────────────────────────────────────
 *
 * A local copy may be touched only when the version is stored in Drive, its migration is
 * `verified`, its retention window has passed, its local copy is in a state that has bytes,
 * and — for deletion — the Drive object answers a live existence check. Any one of those
 * failing skips the version and says why. None of them is inferred from another.
 */
import { Types } from 'mongoose';

import { connectToDatabase } from '@/server/db/connection';
import { getEnv } from '@/server/config/env';
import { FileVersionModel } from '@/server/db/models/file-version.model';
import { ValidationError } from '@/server/errors/app-error';
import { getLogger } from '@/server/logging/logger';
import { auditService } from '@/server/audit/audit.service';
import * as fileRepository from '@/server/repositories/file.repository';
import type { Actor } from '@/server/permissions/actor';
import type { RequestMeta } from '@/server/http/request-meta';
import { getObjectStore } from '@/server/storage';
import { isDriveStorageEnabled } from '@/server/storage/google';
import type { StorageArea } from '@/server/storage/types';

export type LocalCopyAction = 'archive' | 'delete';

export interface LocalCopyCandidate {
  versionId: string;
  fileId: string;
  versionNumber: number;
  sizeBytes: number;
  storageKey: string;
  storageArea: StorageArea;
  archivedStorageKey: string | null;
  localCopyState: string;
  googleDriveFileId: string;
  eligibleAt: Date | null;
}

export interface LocalCopySweepResult {
  action: LocalCopyAction;
  dryRun: boolean;
  eligible: number;
  processed: number;
  skipped: number;
  bytesReclaimed: number;
  /** Why each skipped version was skipped, counted by reason. */
  skippedReasons: Record<string, number>;
}

/**
 * Versions whose local copy could be acted on.
 *
 * `verified` and not merely `uploaded`: bytes reaching Drive is not the same event as those
 * bytes being proved correct, and only the second may ever authorise touching the original.
 * That distinction is why the two statuses exist at all.
 */
export async function listCandidates(input: {
  action: LocalCopyAction;
  limit: number;
  now?: Date;
}): Promise<LocalCopyCandidate[]> {
  await connectToDatabase();

  const now = input.now ?? new Date();
  const wantedStates = input.action === 'archive' ? ['present'] : ['present', 'archived'];

  const docs = await FileVersionModel.find({
    storageProvider: 'google_drive',
    migrationStatus: 'verified',
    googleDriveFileId: { $type: 'string' },
    localCopyState: { $in: wantedStates },
    localCopyEligibleForDeletionAt: { $ne: null, $lte: now },
  })
    .sort({ localCopyEligibleForDeletionAt: 1, _id: 1 })
    .limit(Math.max(1, Math.min(input.limit, 500)))
    .select({
      fileId: 1,
      versionNumber: 1,
      fileSize: 1,
      storageKey: 1,
      storageArea: 1,
      archivedStorageKey: 1,
      localCopyState: 1,
      googleDriveFileId: 1,
      localCopyEligibleForDeletionAt: 1,
    })
    .lean<
      Array<{
        _id: Types.ObjectId;
        fileId: Types.ObjectId;
        versionNumber: number;
        fileSize: number;
        storageKey: string;
        storageArea: string;
        archivedStorageKey?: string | null;
        localCopyState?: string;
        googleDriveFileId: string;
        localCopyEligibleForDeletionAt?: Date | null;
      }>
    >()
    .exec();

  return docs.map((doc) => ({
    versionId: String(doc._id),
    fileId: String(doc.fileId),
    versionNumber: doc.versionNumber,
    sizeBytes: doc.fileSize,
    storageKey: doc.storageKey,
    storageArea: doc.storageArea as StorageArea,
    archivedStorageKey: doc.archivedStorageKey ?? null,
    localCopyState: doc.localCopyState ?? 'present',
    googleDriveFileId: doc.googleDriveFileId,
    eligibleAt: doc.localCopyEligibleForDeletionAt ?? null,
  }));
}

/** How much disk the retained copies are holding, and how much is now eligible. */
export async function summarizeLocalCopies(now = new Date()): Promise<{
  retained: number;
  retainedBytes: number;
  eligible: number;
  eligibleBytes: number;
  archived: number;
  deleted: number;
}> {
  await connectToDatabase();

  const [totals] = await FileVersionModel.aggregate<{
    retained: number;
    retainedBytes: number;
    eligible: number;
    eligibleBytes: number;
    archived: number;
    deleted: number;
  }>([
    { $match: { storageProvider: 'google_drive' } },
    {
      $group: {
        _id: null,
        retained: { $sum: { $cond: [{ $eq: ['$localCopyState', 'present'] }, 1, 0] } },
        retainedBytes: {
          $sum: { $cond: [{ $eq: ['$localCopyState', 'present'] }, '$fileSize', 0] },
        },
        eligible: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$localCopyState', 'present'] },
                  { $eq: ['$migrationStatus', 'verified'] },
                  { $ne: ['$localCopyEligibleForDeletionAt', null] },
                  { $lte: ['$localCopyEligibleForDeletionAt', now] },
                ],
              },
              1,
              0,
            ],
          },
        },
        eligibleBytes: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$localCopyState', 'present'] },
                  { $eq: ['$migrationStatus', 'verified'] },
                  { $ne: ['$localCopyEligibleForDeletionAt', null] },
                  { $lte: ['$localCopyEligibleForDeletionAt', now] },
                ],
              },
              '$fileSize',
              0,
            ],
          },
        },
        archived: { $sum: { $cond: [{ $eq: ['$localCopyState', 'archived'] }, 1, 0] } },
        deleted: { $sum: { $cond: [{ $eq: ['$localCopyState', 'deleted'] }, 1, 0] } },
      },
    },
  ]).exec();

  return {
    retained: totals?.retained ?? 0,
    retainedBytes: totals?.retainedBytes ?? 0,
    eligible: totals?.eligible ?? 0,
    eligibleBytes: totals?.eligibleBytes ?? 0,
    archived: totals?.archived ?? 0,
    deleted: totals?.deleted ?? 0,
  };
}

/** Where an archived copy lives. Same key, different area — so the mapping is obvious. */
function archiveKeyFor(candidate: LocalCopyCandidate): string {
  return `${candidate.storageArea}/${candidate.storageKey}`;
}

export interface SweepInput {
  action: LocalCopyAction;
  limit?: number;
  /** Reports what would happen and touches nothing. */
  dryRun?: boolean;
  /**
   * The request that authorised this, when there is one.
   *
   * Optional because the same code can be driven from a script with no principal. Without it
   * the audit entry names `system:local-copy-cleanup` rather than inventing an administrator
   * — the same rule the rest of this codebase follows for background work.
   */
  audit?: { actor: Actor; meta: RequestMeta };
  now?: Date;
}

/**
 * Archives or deletes eligible local copies.
 *
 * Never runs on a schedule and never as a side effect of anything else. `DELETE_LOCAL_AFTER_
 * MIGRATION` gates deletion, but even with it true nothing happens until a person asks —
 * §18 of the brief calls for exactly that, and the reason is that this is the one operation
 * in the whole migration that cannot be undone.
 */
export async function sweepLocalCopies(input: SweepInput): Promise<LocalCopySweepResult> {
  const env = getEnv();
  const result: LocalCopySweepResult = {
    action: input.action,
    dryRun: input.dryRun === true,
    eligible: 0,
    processed: 0,
    skipped: 0,
    bytesReclaimed: 0,
    skippedReasons: {},
  };

  if (!isDriveStorageEnabled()) {
    throw new ValidationError('Google Drive storage is not enabled on this deployment.');
  }

  if (input.action === 'delete' && !env.DELETE_LOCAL_AFTER_MIGRATION) {
    // A configuration flag, not a permission. The message says which one, because an
    // administrator refused here has done nothing wrong — they have simply not decided yet.
    throw new ValidationError(
      'Deleting local copies is switched off for this deployment. Set DELETE_LOCAL_AFTER_MIGRATION=true ' +
        'once you are satisfied the Shared Drive copies are good, and take a backup first.',
    );
  }

  const candidates = await listCandidates({
    action: input.action,
    limit: input.limit ?? 100,
    ...(input.now ? { now: input.now } : {}),
  });
  result.eligible = candidates.length;

  if (result.dryRun) {
    result.bytesReclaimed = candidates.reduce((total, item) => total + item.sizeBytes, 0);
    return result;
  }

  for (const candidate of candidates) {
    try {
      const done =
        input.action === 'archive'
          ? await archiveOne(candidate, input.audit)
          : await deleteOne(candidate, input.audit);

      if (done) {
        result.processed += 1;
        result.bytesReclaimed += candidate.sizeBytes;
      } else {
        result.skipped += 1;
        countReason(result, 'already in that state');
      }
    } catch (error) {
      result.skipped += 1;
      const reason = error instanceof Error ? error.message : 'unknown error';
      countReason(result, reason.slice(0, 120));
      getLogger().error(
        { versionId: candidate.versionId, action: input.action, err: error },
        'Could not act on a retained local copy',
      );
    }
  }

  return result;
}

function countReason(result: LocalCopySweepResult, reason: string): void {
  result.skippedReasons[reason] = (result.skippedReasons[reason] ?? 0) + 1;
}

/**
 * Moves the bytes aside. Copy first, verify, update the record, and only then remove.
 *
 * That order matters: a crash after the copy leaves two copies and a record pointing at the
 * original, which the next run tidies. The reverse order would leave a window in which
 * neither copy is referenced by anything.
 */
async function archiveOne(
  candidate: LocalCopyCandidate,
  audit?: SweepInput['audit'],
): Promise<boolean> {
  if (candidate.localCopyState !== 'present') return false;

  const local = getObjectStore('local');
  const source = { provider: 'local' as const, key: candidate.storageKey, area: candidate.storageArea };
  const archiveKey = archiveKeyFor(candidate);

  if (!(await local.exists(source))) {
    // Nothing to archive. Recorded rather than treated as success, because a local copy that
    // has already vanished is a fact somebody should know before they rely on rollback.
    throw new Error('the local copy is already missing');
  }

  await local.copy(source, { key: archiveKey, area: 'archives' });

  await FileVersionModel.updateOne(
    { _id: new Types.ObjectId(candidate.versionId), localCopyState: 'present' },
    {
      $set: {
        localCopyState: 'archived',
        archivedStorageKey: archiveKey,
        localCopyArchivedAt: new Date(),
      },
    },
  ).exec();

  await local.remove(source);

  await recordLocalCopyEvent('archived', candidate, audit);
  return true;
}

/**
 * Removes the bytes. The irreversible one.
 *
 * The live existence check is the point of this function. `migrationStatus: 'verified'` was
 * true when a job said so, possibly weeks ago; between then and now somebody may have emptied
 * the Shared Drive trash. Deleting the only other copy on the strength of a stale record is
 * precisely the data-loss event this whole phase design exists to prevent.
 */
async function deleteOne(
  candidate: LocalCopyCandidate,
  audit?: SweepInput['audit'],
): Promise<boolean> {
  if (candidate.localCopyState === 'deleted') return false;

  const { store } = await import('@/server/storage/google').then((module) =>
    module.getGoogleDriveStorage(),
  );

  const presentInDrive = await store.itemExists(candidate.googleDriveFileId);
  if (!presentInDrive) {
    throw new Error('the file is no longer in the Shared Drive');
  }

  const local = getObjectStore('local');
  const locator =
    candidate.localCopyState === 'archived' && candidate.archivedStorageKey
      ? { provider: 'local' as const, key: candidate.archivedStorageKey, area: 'archives' as const }
      : { provider: 'local' as const, key: candidate.storageKey, area: candidate.storageArea };

  // Removal is idempotent in every provider here, so an already-missing object is not an
  // error — the record still has to be brought in line with reality.
  await local.remove(locator);

  await FileVersionModel.updateOne(
    { _id: new Types.ObjectId(candidate.versionId) },
    {
      $set: {
        localCopyState: 'deleted',
        localCopyDeletedAt: new Date(),
        archivedStorageKey: null,
      },
    },
  ).exec();

  await recordLocalCopyEvent('deleted', candidate, audit);
  return true;
}

async function recordLocalCopyEvent(
  kind: 'archived' | 'deleted',
  candidate: LocalCopyCandidate,
  audit?: SweepInput['audit'],
): Promise<void> {
  const file = await fileRepository.findById(candidate.fileId, { includeDeleted: true });

  const event = {
    action:
      kind === 'archived'
        ? ('storage_migration.local_copy_archived' as const)
        : ('storage_migration.local_copy_deleted' as const),
    entityType: 'file',
    entityId: candidate.fileId,
    ...(file ? { entityLabel: file.displayName } : {}),
    newValue: {
      versionId: candidate.versionId,
      versionNumber: candidate.versionNumber,
      sizeBytes: candidate.sizeBytes,
      googleDriveFileId: candidate.googleDriveFileId,
      localCopyState: kind,
    },
    // Deletion is the one irreversible step in the migration, so it is recorded at a severity
    // that survives a filtered audit view.
    severity: kind === 'deleted' ? ('warning' as const) : ('notice' as const),
  };

  if (audit) {
    await auditService.recordForActor(audit.actor, audit.meta, event);
    return;
  }

  await auditService.recordSystem({
    ...event,
    organizationId: file?.organizationId ?? null,
    actorLabel: 'local-copy-cleanup',
  });
}

export const localCopyService = { listCandidates, summarizeLocalCopies, sweepLocalCopies };
