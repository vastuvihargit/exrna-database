/**
 * Operational status for administrators.
 *
 * `/api/health/ready` answers a load balancer's question — is this instance usable right
 * now. This answers a different one: is anything quietly going wrong that nobody will
 * notice until it matters. Those are the failures a single-server, local-storage system
 * actually dies of:
 *
 *   • the disk filling up
 *   • backups that stopped running three weeks ago
 *   • backups that run but have never been restored from
 *   • quarantined and failed uploads accumulating with nobody looking
 *   • an antivirus that is configured but unreachable
 *
 * Gathering the numbers lives here; deciding what they mean lives in `system-checks.ts`,
 * which is pure and therefore properly testable.
 *
 * Every figure here is organization-wide and administrative, which is why the route
 * requires company-scoped `audit.view` — the same bar as the audit log.
 */
import { getEnv } from '@/server/config/env';
import { checkDatabaseHealth } from '@/server/db/connection';
import type { Actor } from '@/server/permissions/actor';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { ForbiddenError } from '@/server/errors/app-error';
import * as sessionRepository from '@/server/repositories/upload-session.repository';
import * as versionRepository from '@/server/repositories/file-version.repository';
import {
  checkDriveConnection,
  describeDriveStorage,
  getStorageProvider,
  readBackupStatus,
  readRestoreDrillStatus,
} from '@/server/storage';
import { getMalwareScanner } from '@/server/security/malware-scanner';
import { countPending as countPendingDriveTransfers } from './storage-migration/pending-transfers';
import { getSyncStatus, syncIntervalMinutes } from './drive-sync.service';
import { summarizeLocalCopies } from './storage-migration/local-copies';
import {
  evaluateApprovalIntegrity,
  evaluateBackup,
  evaluateDatabase,
  evaluateDriveSync,
  evaluateDisk,
  evaluateDriveStorage,
  evaluateDriveTransferQueue,
  evaluateMalwareScanning,
  evaluateRestoreDrill,
  evaluateRetainedLocalCopies,
  evaluateUploads,
  overallSeverity,
  type Severity,
  type SystemCheck,
} from './system-checks';

export type { Severity, SystemCheck } from './system-checks';

export interface SystemStatus {
  status: Severity;
  checks: SystemCheck[];
  storage: {
    totalBytes: number | null;
    freeBytes: number | null;
    freePercent: number | null;
    minFreeBytes: number;
    storedObjects: number;
  };
  backup: {
    lastRunAt: Date | null;
    ageHours: number | null;
    offsite: boolean;
    verified: boolean;
    ok: boolean | null;
    detail: string;
    lastDrillAt: Date | null;
    lastDrillOk: boolean | null;
  };
  uploads: { quarantined: number; failed: number; rejected: number; stale: number };
  malwareScanning: { enabled: boolean; scanner: string; reachable: boolean; failClosed: boolean };
  /**
   * Google Shared Drive connection state.
   *
   * This block does carry the drive id and the service-account address, unlike the public
   * readiness probe, because they are exactly what an administrator needs in order to fix a
   * broken connection — and this whole object is already behind company-scoped
   * `audit.view`. It never carries the key, in any form.
   */
  driveStorage: {
    enabled: boolean;
    configured: boolean;
    connected: boolean;
    isDefaultProvider: boolean;
    driveName: string | null;
    sharedDriveId: string | null;
    rootFolderId: string | null;
    serviceAccountEmail: string | null;
    keySource: 'file' | 'inline' | null;
    error: string | null;
    warnings: string[];
    checkedAt: Date | null;
    /** Uploaded but not yet moved to Drive. Readable throughout; see system-checks. */
    pendingTransfers: number;
  };
  generatedAt: Date;
}

/**
 * Gathers every operational signal.
 *
 * Deliberately takes no actor: the scheduled monitor calls this directly from the server
 * process, and inventing a synthetic administrator identity for a background job would
 * put a permission-bearing principal into the audit trail that nobody can be held to.
 * Authorization is the caller's job — see `getSystemStatus` for the HTTP entry point.
 */
export async function collectSystemStatus(): Promise<SystemStatus> {
  const env = getEnv();
  const storage = getStorageProvider();
  const scanner = getMalwareScanner();

  const driveSummary = describeDriveStorage();

  const [
    capacity,
    database,
    storedObjects,
    uploadCounts,
    backup,
    drill,
    scannerReachable,
    drive,
    pendingDriveTransfers,
    supersededApprovals,
    syncStatus,
    localCopies,
  ] =
    await Promise.all([
      storage.getCapacity('originals').catch(() => null),
      checkDatabaseHealth(),
      versionRepository.countStoredObjects().catch(() => 0),
      sessionRepository.countByStatus().catch(() => ({}) as Record<string, number>),
      readBackupStatus(),
      readRestoreDrillStatus(),
      scanner.enabled ? scanner.ping().catch(() => false) : Promise.resolve(false),
      // Never allowed to fail the whole page: the panel whose job is to explain a broken
      // Drive connection must still render when the connection is broken.
      checkDriveConnection().catch(() => null),
      countPendingDriveTransfers().catch(() => 0),
      versionRepository.countSupersededApprovals().catch(() => 0),
      // Same rule as the connection check: the panel whose job is to explain that
      // synchronization has stopped must still render when it has stopped.
      getSyncStatus().catch(() => ({
        enabled: false,
        states: [],
        conflicts: 0,
        minutesSinceLastPoll: null,
      })),
      summarizeLocalCopies().catch(() => ({
        retained: 0,
        retainedBytes: 0,
        eligible: 0,
        eligibleBytes: 0,
        archived: 0,
        deleted: 0,
      })),
    ]);

  const now = new Date();
  const uploads = {
    quarantined: uploadCounts.quarantined ?? 0,
    failed: uploadCounts.failed ?? 0,
    rejected: uploadCounts.rejected ?? 0,
    stale: (uploadCounts.uploading ?? 0) + (uploadCounts.pending ?? 0),
  };

  const checks: SystemCheck[] = [
    evaluateDisk(capacity, env.minFreeDiskBytes, env.MIN_FREE_DISK_GB),
    ...evaluateBackup(backup, now),
    evaluateRestoreDrill(drill, now),
    evaluateUploads(uploads),
    evaluateMalwareScanning({
      enabled: scanner.enabled,
      name: scanner.name,
      reachable: scannerReachable,
      failClosed: env.MALWARE_SCAN_FAIL_CLOSED,
    }),
    evaluateDatabase(database),
    evaluateDriveStorage({
      enabled: driveSummary.enabled,
      configured: driveSummary.configured,
      connected: drive?.connected ?? false,
      isDefaultProvider: driveSummary.defaultProvider === 'google_drive',
      driveName: drive?.driveName ?? null,
      error: drive?.error ?? null,
      warnings: driveSummary.warnings,
    }),
    evaluateDriveTransferQueue({
      enabled: driveSummary.enabled,
      isDefaultProvider: driveSummary.defaultProvider === 'google_drive',
      pending: pendingDriveTransfers,
    }),
    evaluateApprovalIntegrity({
      enabled: driveSummary.enabled,
      superseded: supersededApprovals,
    }),
    evaluateRetainedLocalCopies({
      enabled: driveSummary.enabled,
      retained: localCopies.retained,
      retainedBytes: localCopies.retainedBytes,
      eligible: localCopies.eligible,
      eligibleBytes: localCopies.eligibleBytes,
    }),
    evaluateDriveSync({
      enabled: driveSummary.enabled,
      everRan: syncStatus.states.some((entry) => entry.lastSuccessfulPollAt !== null),
      minutesSinceLastPoll: syncStatus.minutesSinceLastPoll,
      intervalMinutes: syncIntervalMinutes(),
      conflicts: syncStatus.conflicts,
      consecutiveFailures: Math.max(
        0,
        ...syncStatus.states.map((entry) => entry.consecutiveFailures),
      ),
    }),
  ];

  const freePercent =
    capacity && capacity.totalBytes > 0 ? (capacity.freeBytes / capacity.totalBytes) * 100 : null;

  return {
    status: overallSeverity(checks),
    checks,
    storage: {
      totalBytes: capacity?.totalBytes ?? null,
      freeBytes: capacity?.freeBytes ?? null,
      freePercent,
      minFreeBytes: env.minFreeDiskBytes,
      storedObjects,
    },
    backup: {
      lastRunAt: backup.finishedAt,
      ageHours: backup.finishedAt ? (now.getTime() - backup.finishedAt.getTime()) / 3_600_000 : null,
      offsite: backup.offsite,
      verified: backup.verified,
      ok: backup.ok,
      detail: backup.detail,
      lastDrillAt: drill.finishedAt,
      lastDrillOk: drill.ok,
    },
    uploads,
    malwareScanning: {
      enabled: scanner.enabled,
      scanner: scanner.name,
      reachable: scannerReachable,
      failClosed: env.MALWARE_SCAN_FAIL_CLOSED,
    },
    driveStorage: {
      enabled: driveSummary.enabled,
      configured: driveSummary.configured,
      connected: drive?.connected ?? false,
      isDefaultProvider: driveSummary.defaultProvider === 'google_drive',
      driveName: drive?.driveName ?? null,
      sharedDriveId: driveSummary.sharedDriveId,
      rootFolderId: driveSummary.rootFolderId,
      serviceAccountEmail: driveSummary.serviceAccountEmail,
      keySource: driveSummary.keySource,
      error: drive?.error ?? null,
      warnings: driveSummary.warnings,
      checkedAt: drive?.checkedAt ?? null,
      pendingTransfers: pendingDriveTransfers,
    },
    generatedAt: now,
  };
}

/** The authorized entry point used by the admin API. */
export async function getSystemStatus(actor: Actor): Promise<SystemStatus> {
  try {
    assertCompanyPermission(actor, 'audit.view');
  } catch {
    throw new ForbiddenError('You cannot view system status');
  }

  return collectSystemStatus();
}

export const systemService = { getSystemStatus, collectSystemStatus };
