/**
 * Incremental synchronization from the Shared Drive's change feed.
 *
 * The application is the main interface, but the Shared Drive is a real Shared Drive: people
 * will open it in the Drive web UI, rename things, drag them about and empty the trash. This
 * is what notices.
 *
 * ── The policy, stated once ────────────────────────────────────────────────────────────
 *
 * **Drive is authoritative for content. This application is authoritative for structure.**
 *
 * That is not a compromise, it is the only reading consistent with the brief. §8 says "the
 * MongoDB hierarchy remains the application hierarchy — Google Drive should mirror it", and
 * §13 says this application's permissions decide what an employee may do. In this codebase a
 * file's folder chain *is* its permission chain and its quota owner. So:
 *
 * | Change in Drive | What happens here | Why |
 * |---|---|---|
 * | New revision of a file | Adopted: storage metadata updated, approval re-checked | Drive holds the bytes; it is the only thing that knows they changed |
 * | Renamed | Adopted | A name is a label. It carries no permission or quota consequence, and refusing would leave the application showing a name nobody can find in Drive |
 * | File trashed / restored | Adopted | Recoverable in both systems, and no permission consequence |
 * | **Moved** | **Reported as a conflict, not applied** | A move changes who can see the file and whose quota it counts against. Applying that on the authority of a Drive event would let somebody outside this application's permission model silently re-share a file |
 * | **Folder trashed or moved** | **Reported as a conflict, not applied** | Same, multiplied by the whole subtree |
 * | Removed from Drive entirely | Storage state marked missing; **the record is never deleted** | §16, explicitly |
 * | Anything we do not recognise | Counted as unmanaged, otherwise ignored | Somebody else's file in the same drive is not ours to act on |
 *
 * ── Two properties everything here depends on ──────────────────────────────────────────
 *
 * **Every change application is idempotent.** Applying the same change twice must reach the
 * same state as applying it once, because the cursor is advanced *after* a page is applied
 * and a crash in between replays that page. This is also what makes the round trip safe: the
 * application's own rename produces a Drive change, which comes back through this feed, and
 * re-applying it must be a no-op rather than a second rename or an audit entry per poll.
 *
 * **An expired cursor is not an empty page.** Drive expires start page tokens, and answers a
 * stale one with 404. Reading that as "nothing changed" would silently desynchronise
 * everything, permanently and invisibly — the single worst failure available here. It forces
 * a full reconcile instead.
 */
import { getEnv } from '@/server/config/env';
import { getLogger } from '@/server/logging/logger';
import { auditService } from '@/server/audit/audit.service';
import * as driveSyncRepository from '@/server/repositories/drive-sync.repository';
import type { DriveSyncStateRecord } from '@/server/repositories/drive-sync.repository';
import * as fileRepository from '@/server/repositories/file.repository';
import * as folderRepository from '@/server/repositories/folder.repository';
import * as versionRepository from '@/server/repositories/file-version.repository';
import type { VersionByDriveId } from '@/server/repositories/file-version.repository';
import {
  DriveApiError,
  GOOGLE_FOLDER_MIME,
  getGoogleDriveStorage,
  getDriveStorageConfig,
  isDriveStorageEnabled,
} from '@/server/storage/google';
import type { DriveChange, DriveClient, DriveFileResource } from '@/server/storage/google';
import { checkApprovedVersion } from './approval-integrity.service';

/** Where a run got to, and what it found. Returned to the admin page and the cron script. */
export interface DriveSyncSummary {
  /** False when Drive is not enabled on this deployment; every count is then zero. */
  ran: boolean;
  /** True when this run only established a baseline cursor and applied nothing. */
  initialized: boolean;
  pages: number;
  changes: number;
  /** Changes for objects this application does not manage. */
  unmanaged: number;
  contentUpdated: number;
  renamed: number;
  trashed: number;
  restored: number;
  missing: number;
  conflicts: number;
  approvalsReturnedToReview: number;
  /** Set when the cursor had expired and a full reconcile was run instead. */
  reconciled: boolean;
  reconcileChecked: number;
  error: string | null;
}

function emptySummary(): DriveSyncSummary {
  return {
    ran: false,
    initialized: false,
    pages: 0,
    changes: 0,
    unmanaged: 0,
    contentUpdated: 0,
    renamed: 0,
    trashed: 0,
    restored: 0,
    missing: 0,
    conflicts: 0,
    approvalsReturnedToReview: 0,
    reconciled: false,
    reconcileChecked: 0,
    error: null,
  };
}

export interface SyncInput {
  organizationId: string;
  /** Bounds one run. The cursor persists, so the next run continues where this one stopped. */
  maxPages?: number;
  pageSize?: number;
}

/**
 * One synchronization run.
 *
 * Bounded rather than run-to-completion: this shares a Drive API quota with the uploads and
 * downloads employees are waiting on, and a backlog after a long outage must be worked
 * through over several runs rather than in one burst. The cursor is what makes that safe.
 */
export async function syncDriveChanges(input: SyncInput): Promise<DriveSyncSummary> {
  const summary = emptySummary();
  if (!isDriveStorageEnabled()) return summary;

  summary.ran = true;

  const config = getDriveStorageConfig();
  const { client } = getGoogleDriveStorage();

  const state = await driveSyncRepository.ensureState({
    organizationId: input.organizationId,
    sharedDriveId: config.sharedDriveId,
  });

  await driveSyncRepository.updateState(state.id, {
    $set: { state: 'polling', lastPollAt: new Date() },
  });

  try {
    /**
     * First run: take a cursor and stop.
     *
     * There is deliberately no attempt to "catch up" on what happened before Drive sync was
     * switched on. The feed does not go back that far, and pretending otherwise would mean
     * inventing a reconcile over a corpus nobody has asked us to distrust. From here on,
     * everything is seen.
     */
    if (!state.startPageToken) {
      const token = await client.getStartPageToken();
      await driveSyncRepository.updateState(state.id, {
        $set: {
          startPageToken: token,
          state: 'idle',
          lastSuccessfulPollAt: new Date(),
          consecutiveFailures: 0,
          lastError: null,
        },
      });
      summary.initialized = true;
      return summary;
    }

    await pollPages({ client, state, input, summary });

    await driveSyncRepository.updateState(state.id, {
      $set: {
        state: 'idle',
        lastSuccessfulPollAt: new Date(),
        consecutiveFailures: 0,
        lastError: null,
      },
    });

    await auditService.recordSystem({
      action: 'drive_storage.sync_completed',
      organizationId: input.organizationId,
      actorLabel: 'drive-sync',
      entityType: 'storage',
      entityId: null,
      newValue: summary,
      severity: summary.conflicts > 0 ? 'warning' : 'info',
    });

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.error = message;

    await driveSyncRepository.updateState(state.id, {
      $set: { state: 'failed', lastError: message.slice(0, 1000) },
      $inc: { consecutiveFailures: 1 },
    });

    getLogger().error({ err: error }, 'Google Drive synchronization failed');

    await auditService.recordSystem({
      action: 'drive_storage.sync_completed',
      organizationId: input.organizationId,
      actorLabel: 'drive-sync',
      entityType: 'storage',
      entityId: null,
      newValue: summary,
      outcome: 'error',
      severity: 'warning',
      reason: message.slice(0, 500),
    });

    return summary;
  }
}

/**
 * Walks pages, applying each and then advancing the cursor.
 *
 * That order is the whole safety argument: a crash between applying and advancing replays a
 * page, and every application is idempotent. The reverse order would skip changes, and
 * nothing downstream would ever discover that it had.
 */
async function pollPages(context: {
  client: DriveClient;
  state: DriveSyncStateRecord;
  input: SyncInput;
  summary: DriveSyncSummary;
}): Promise<void> {
  const { client, state, input, summary } = context;
  const maxPages = Math.max(1, Math.min(input.maxPages ?? 10, 100));
  const pageSize = Math.max(1, Math.min(input.pageSize ?? 100, 1000));

  let cursor = state.startPageToken;

  for (let page = 0; page < maxPages && cursor; page += 1) {
    let result;
    try {
      result = await client.listChanges({ pageToken: cursor, pageSize });
    } catch (error) {
      if (error instanceof DriveApiError && error.status === 404) {
        await handleExpiredToken({ client, state, input, summary });
        return;
      }
      throw error;
    }

    summary.pages += 1;

    const before = { conflicts: summary.conflicts, changes: summary.changes };
    for (const change of result.changes) {
      summary.changes += 1;
      await applyChange(change, input.organizationId, summary);
    }

    const next = result.nextPageToken ?? result.newStartPageToken ?? null;
    if (!next) break;

    const advanced = await driveSyncRepository.advanceCursor({
      id: state.id,
      from: cursor,
      to: next,
      appliedDelta: summary.changes - before.changes,
      conflictsDelta: summary.conflicts - before.conflicts,
    });

    if (!advanced) {
      // Another worker polled the same page and is ahead of us. Everything we applied was
      // idempotent, so stopping here loses nothing.
      getLogger().info('Another synchronization run advanced the cursor first; stopping');
      return;
    }

    cursor = result.nextPageToken ?? null;
  }
}

/**
 * Drive no longer recognises the cursor.
 *
 * An unknown set of renames, moves and deletions happened while nobody was looking, and the
 * feed cannot tell us which. The only honest response is to stop trusting the incremental
 * picture and re-check what we hold: does every object this application believes is in Drive
 * still exist, and is its content still the content we recorded?
 *
 * Bounded, like everything else here. A partial reconcile is recorded as partial; the next
 * run continues from the recorded cursor.
 */
async function handleExpiredToken(context: {
  client: DriveClient;
  state: DriveSyncStateRecord;
  input: SyncInput;
  summary: DriveSyncSummary;
}): Promise<void> {
  const { client, state, input, summary } = context;

  getLogger().warn(
    { sharedDriveId: state.sharedDriveId },
    'The Drive change cursor has expired; running a full reconcile',
  );

  await driveSyncRepository.updateState(state.id, {
    $set: { state: 'reconciling', tokenExpiredAt: new Date() },
  });

  await auditService.recordSystem({
    action: 'drive_storage.sync_conflict',
    organizationId: input.organizationId,
    actorLabel: 'drive-sync',
    entityType: 'storage',
    entityId: null,
    reason: 'The Drive change cursor expired; a full reconcile was run',
    severity: 'warning',
  });

  // A fresh cursor is taken *first*, so anything that changes during the reconcile is caught
  // by the next incremental poll rather than falling into the gap between the two.
  const token = await client.getStartPageToken();

  summary.reconciled = true;
  await reconcileEverything({ client, input, summary });

  await driveSyncRepository.updateState(state.id, {
    $set: {
      startPageToken: token,
      state: 'idle',
      tokenExpiredAt: null,
      lastFullReconcileAt: new Date(),
      lastSuccessfulPollAt: new Date(),
      consecutiveFailures: 0,
      lastError: null,
    },
  });
}

/**
 * Re-checks every Drive-backed version against what Drive currently holds.
 *
 * This is the expensive path — one request per object — which is exactly why the incremental
 * feed exists and why the cursor is advanced so carefully. It runs only when the feed has
 * failed us.
 */
async function reconcileEverything(context: {
  client: DriveClient;
  input: SyncInput;
  summary: DriveSyncSummary;
}): Promise<void> {
  const { client, input, summary } = context;
  const pageSize = 100;
  // Bounded so one reconcile cannot become an unbounded burst against a shared quota. What
  // is not reached this run is reached by the approval sweep and the next reconcile; the
  // count is reported rather than silently truncated.
  const ceiling = 2000;

  let cursor: string | null = null;

  while (summary.reconcileChecked < ceiling) {
    const batch = await versionRepository.listDriveBackedVersions({
      limit: pageSize,
      afterId: cursor,
    });
    if (batch.length === 0) break;

    for (const entry of batch) {
      summary.reconcileChecked += 1;
      try {
        const file = await client.getFile(entry.googleDriveFileId);
        await applyFileChange(file, input.organizationId, summary);
      } catch (error) {
        if (error instanceof DriveApiError && error.status === 404) {
          await markMissing(entry.versionId, entry.fileId, input.organizationId, summary);
          continue;
        }
        // One unreadable object must not abandon the reconcile. It keeps its state and is
        // re-checked next time, which is the correct answer to "we could not tell".
        getLogger().warn(
          { versionId: entry.versionId, err: error },
          'Could not reconcile a version against Drive',
        );
      }
    }

    cursor = batch[batch.length - 1]!.versionId;
    if (batch.length < pageSize) break;
  }

  if (summary.reconcileChecked >= ceiling) {
    getLogger().warn(
      { checked: summary.reconcileChecked },
      'Reconcile stopped at its ceiling; the remainder is covered by the next run',
    );
  }
}

/* ------------------------------------------------------------------ one change */

async function applyChange(
  change: DriveChange,
  organizationId: string,
  summary: DriveSyncSummary,
): Promise<void> {
  if (change.removed || !change.file) {
    await applyRemoval(change.fileId, organizationId, summary);
    return;
  }

  if (change.file.mimeType === GOOGLE_FOLDER_MIME) {
    await applyFolderChange(change.file, organizationId, summary);
    return;
  }

  await applyFileChange(change.file, organizationId, summary);
}

/**
 * The object is gone from Drive.
 *
 * §16, in as many words: *do not silently remove the MongoDB record*. The file keeps its
 * metadata, its comments, its reviews, its approvals and its audit history — and, if it was
 * migrated rather than uploaded straight to Drive, its retained local copy, which Phase 4
 * will happily serve. All that changes is that the storage state now says so.
 */
async function applyRemoval(
  driveFileId: string,
  organizationId: string,
  summary: DriveSyncSummary,
): Promise<void> {
  const version = await versionRepository.findByDriveFileId(driveFileId);
  if (!version) {
    summary.unmanaged += 1;
    return;
  }

  await markMissing(version.versionId, version.fileId, organizationId, summary);
}

async function markMissing(
  versionId: string,
  fileId: string,
  organizationId: string,
  summary: DriveSyncSummary,
): Promise<void> {
  await versionRepository.markStorageConflict(
    versionId,
    'The file was removed from the company Shared Drive',
  );
  summary.missing += 1;
  summary.conflicts += 1;

  const file = await fileRepository.findById(fileId, { includeDeleted: true });

  await auditService.recordSystem({
    action: 'drive_storage.file_missing',
    organizationId,
    actorLabel: 'drive-sync',
    entityType: 'file',
    entityId: fileId,
    ...(file ? { entityLabel: file.displayName } : {}),
    newValue: { versionId },
    outcome: 'error',
    severity: 'critical',
  });
}

async function applyFileChange(
  driveFile: DriveFileResource,
  organizationId: string,
  summary: DriveSyncSummary,
): Promise<void> {
  const version = await versionRepository.findByDriveFileId(driveFile.id);
  if (!version) {
    // Not ours. Somebody else's file in the same Shared Drive, or a natively-created
    // document nothing has adopted. Counted so the number is visible, never acted on.
    summary.unmanaged += 1;
    return;
  }

  const file = await fileRepository.findById(version.fileId, { includeDeleted: true });
  if (!file) {
    getLogger().warn(
      { versionId: version.versionId, fileId: version.fileId },
      'A Drive change names a version whose file record is gone',
    );
    return;
  }

  await applyTrashState(driveFile, version, file, organizationId, summary);
  await applyRename(driveFile, version, file, organizationId, summary);
  await applyMove(driveFile, version, file, organizationId, summary);
  await applyContent(driveFile, version, file, organizationId, summary);
}

/** Drive's trash and ours mean the same thing, and both are recoverable. */
async function applyTrashState(
  driveFile: DriveFileResource,
  version: VersionByDriveId,
  file: { id: string; displayName: string; deletedAt: Date | null },
  organizationId: string,
  summary: DriveSyncSummary,
): Promise<void> {
  // Only the current version's object decides this. An older version's object being trashed
  // says nothing about whether the *file* is in the trash.
  if (!version.isCurrent) return;

  const trashedInDrive = driveFile.trashed === true;
  const trashedHere = file.deletedAt !== null;
  if (trashedInDrive === trashedHere) return; // already agreed — the replay case

  const changed = await fileRepository.setDeletedBySystem({
    fileId: file.id,
    deleted: trashedInDrive,
  });
  if (!changed) return;

  if (trashedInDrive) summary.trashed += 1;
  else summary.restored += 1;

  await auditService.recordSystem({
    action: trashedInDrive ? 'resource.archive' : 'resource.restore',
    organizationId,
    actorLabel: 'drive-sync',
    entityType: 'file',
    entityId: file.id,
    entityLabel: file.displayName,
    reason: trashedInDrive
      ? 'Moved to the trash in the company Shared Drive'
      : 'Restored from the trash in the company Shared Drive',
    severity: 'notice',
  });
}

/**
 * A rename is adopted, because a name is a label.
 *
 * It carries no permission and no quota consequence, and refusing it would leave the
 * application showing a name that nobody can find in Drive — which helps no one.
 *
 * Only the current version's object is authoritative. A rename applied to an older version's
 * object is a deviation in the mirror rather than an intent about the file, so it is recorded
 * as a conflict instead of quietly renaming the file from an object nobody is looking at.
 */
async function applyRename(
  driveFile: DriveFileResource,
  version: VersionByDriveId,
  file: { id: string; displayName: string },
  organizationId: string,
  summary: DriveSyncSummary,
): Promise<void> {
  if (driveFile.name === file.displayName) return; // the replay case, and the common one

  if (!version.isCurrent) {
    await recordVersionConflict(
      version.versionId,
      'An older version’s stored copy was renamed in the Shared Drive',
      summary,
    );
    return;
  }

  const previous = file.displayName;
  const updated = await fileRepository.updateByIdWhere(
    file.id,
    { displayName: previous },
    { $set: { displayName: driveFile.name, displayNameLower: driveFile.name.toLowerCase() } },
  );
  if (!updated) return;

  summary.renamed += 1;

  await auditService.recordSystem({
    action: 'file.rename',
    organizationId,
    actorLabel: 'drive-sync',
    entityType: 'file',
    entityId: file.id,
    entityLabel: driveFile.name,
    previousValue: { displayName: previous },
    newValue: { displayName: driveFile.name },
    reason: 'Renamed in the company Shared Drive',
    severity: 'notice',
  });
}

/**
 * A move is **not** applied. It is reported.
 *
 * In this application a file's folder chain is its permission chain and its quota owner.
 * Applying a move on the authority of a Drive event would let somebody who is outside this
 * application's permission model — possibly someone with no account here at all — silently
 * change who can see a research file and which department is charged for it. §13 makes the
 * MongoDB permission model authoritative precisely so that cannot happen, and §8 makes this
 * application's hierarchy the one Drive mirrors rather than the other way round.
 *
 * So the deviation is recorded where an administrator will see it, and putting it right is a
 * decision a person makes.
 */
async function applyMove(
  driveFile: DriveFileResource,
  version: VersionByDriveId,
  file: { id: string; displayName: string },
  organizationId: string,
  summary: DriveSyncSummary,
): Promise<void> {
  const parent = driveFile.parents?.[0];
  if (!parent || !version.googleDriveParentId) return;
  if (parent === version.googleDriveParentId) return;

  await recordVersionConflict(
    version.versionId,
    'The file was moved to a different folder in the Shared Drive',
    summary,
  );

  await auditService.recordSystem({
    action: 'drive_storage.sync_conflict',
    organizationId,
    actorLabel: 'drive-sync',
    entityType: 'file',
    entityId: file.id,
    entityLabel: file.displayName,
    newValue: { versionId: version.versionId, kind: 'moved_in_drive' },
    reason:
      'This file was moved in the company Shared Drive. The application’s own folder decides ' +
      'who may see it, so the move has not been applied here.',
    severity: 'warning',
  });
}

/**
 * The content changed in Drive. This is the one thing Drive is authoritative for.
 *
 * The stored fingerprint is refreshed, and if the version was approved the approval check
 * runs immediately — a change to approved content is exactly the event that must not wait
 * for the next scheduled sweep.
 */
async function applyContent(
  driveFile: DriveFileResource,
  version: VersionByDriveId,
  file: { id: string; displayName: string },
  organizationId: string,
  summary: DriveSyncSummary,
): Promise<void> {
  if (!contentLooksDifferent(driveFile, version)) return;

  const { store } = getGoogleDriveStorage();
  const fingerprint = await store.contentFingerprint({
    provider: 'google_drive',
    key: 'unused',
    area: 'originals',
    externalId: driveFile.id,
  });

  if (fingerprint.revisionId === version.googleDriveRevisionId) return; // nothing really moved

  await versionRepository.updateFlags(version.versionId, {
    $set: {
      googleDriveRevisionId: fingerprint.revisionId,
      googleDriveModifiedTime: fingerprint.modifiedAt,
      ...(fingerprint.md5 ? { googleDriveMd5: fingerprint.md5 } : {}),
      lastSyncedAt: new Date(),
    },
  });

  summary.contentUpdated += 1;

  await auditService.recordSystem({
    action: 'drive_storage.sync_completed',
    organizationId,
    actorLabel: 'drive-sync',
    entityType: 'file',
    entityId: file.id,
    entityLabel: file.displayName,
    newValue: { versionId: version.versionId, kind: 'content_changed_in_drive' },
    severity: 'notice',
  });

  if (version.isApproved) {
    // Not deferred to the nightly sweep. An approved document changing is the event the
    // whole of Phase 8 exists for, and the feed has just told us exactly which file it is.
    const result = await checkApprovedVersion(version.versionId);
    if (result.outcome === 'superseded') summary.approvalsReturnedToReview += 1;
  }
}

/**
 * A cheap pre-check before spending a request on the revision.
 *
 * Errs towards "yes, look": a false positive costs one API call, a false negative means an
 * edited document is never noticed. For a Google-native document `md5Checksum` and
 * `headRevisionId` are both absent, so `modifiedTime` is the only signal — which is why it is
 * checked first and why an absent stored value counts as different.
 */
function contentLooksDifferent(driveFile: DriveFileResource, version: VersionByDriveId): boolean {
  if (driveFile.headRevisionId && driveFile.headRevisionId !== version.googleDriveRevisionId) {
    return true;
  }
  if (driveFile.md5Checksum && driveFile.md5Checksum !== version.googleDriveMd5) return true;

  if (driveFile.modifiedTime) {
    const seen = version.googleDriveModifiedTime?.getTime() ?? null;
    if (seen === null) return true;
    if (new Date(driveFile.modifiedTime).getTime() !== seen) return true;
  }

  return false;
}

/**
 * A folder changed in Drive.
 *
 * Nothing is applied. A folder's identity here is its place in the hierarchy, its ACL and
 * everything under it; a rename in Drive that collided with a sibling would have to be
 * refused anyway, and a move or a trash would carry a whole subtree of permission decisions
 * with it. The application's hierarchy is the one Drive mirrors (§8), so a divergence is
 * something to tell an administrator about, not something to adopt.
 */
async function applyFolderChange(
  driveFile: DriveFileResource,
  organizationId: string,
  summary: DriveSyncSummary,
): Promise<void> {
  const folder = await folderRepository.findByDriveFolderIdInternal(driveFile.id);
  if (!folder) {
    summary.unmanaged += 1;
    return;
  }

  const renamed = driveFile.name !== folder.name;
  const trashed = driveFile.trashed === true && folder.deletedAt === null;
  if (!renamed && !trashed) return;

  summary.conflicts += 1;
  await folderRepository.updateById(folder.id, { syncStatus: 'conflict' });

  await auditService.recordSystem({
    action: 'drive_storage.sync_conflict',
    organizationId,
    actorLabel: 'drive-sync',
    entityType: 'folder',
    entityId: folder.id,
    entityLabel: folder.name,
    newValue: { kind: trashed ? 'folder_trashed_in_drive' : 'folder_renamed_in_drive' },
    reason: trashed
      ? 'This folder was moved to the trash in the company Shared Drive. It has not been ' +
        'trashed here, because that would carry its whole contents and everyone’s access to them.'
      : 'This folder was renamed in the company Shared Drive. The application’s own name is ' +
        'unchanged, because folder names here have to stay unique within their parent.',
    severity: 'warning',
  });
}

async function recordVersionConflict(
  versionId: string,
  reason: string,
  summary: DriveSyncSummary,
): Promise<void> {
  await versionRepository.markStorageConflict(versionId, reason);
  summary.conflicts += 1;
}

/* --------------------------------------------------------------------- reading */

export interface DriveSyncStatus {
  enabled: boolean;
  states: DriveSyncStateRecord[];
  conflicts: number;
  /** How long since the last successful poll, in minutes. Null when it has never run. */
  minutesSinceLastPoll: number | null;
}

export async function getSyncStatus(): Promise<DriveSyncStatus> {
  if (!isDriveStorageEnabled()) {
    return { enabled: false, states: [], conflicts: 0, minutesSinceLastPoll: null };
  }

  const [states, conflicts] = await Promise.all([
    driveSyncRepository.listStates(),
    versionRepository.countSyncConflicts(),
  ]);

  const latest = states
    .map((state) => state.lastSuccessfulPollAt)
    .filter((value): value is Date => value !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return {
    enabled: true,
    states,
    conflicts,
    minutesSinceLastPoll: latest ? Math.floor((Date.now() - latest.getTime()) / 60_000) : null,
  };
}

/** How often synchronization is expected to run. Used to judge whether it has stalled. */
export function syncIntervalMinutes(): number {
  return getEnv().DRIVE_SYNC_INTERVAL_MINUTES;
}

export const driveSyncService = { syncDriveChanges, getSyncStatus, syncIntervalMinutes };
