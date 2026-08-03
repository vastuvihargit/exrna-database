/**
 * Interpretation of operational signals — pure, no I/O.
 *
 * Separated from `system.service.ts` because the interesting part of a health check is
 * not gathering the numbers, it is deciding what they mean, and that decision deserves
 * tests that do not need a database, a disk or a clock. Every function here takes the
 * facts and the current time and returns a judgement.
 *
 * The severities are load-bearing. `critical` means somebody should be woken up;
 * `warning` means somebody should look today. Inflating everything to critical is how
 * an alerting system gets muted, so the thresholds below are deliberately conservative.
 */
import type { BackupStatus, RestoreDrillStatus } from '@/server/storage/backup-status';

export type Severity = 'ok' | 'warning' | 'critical';

export interface SystemCheck {
  key: string;
  label: string;
  severity: Severity;
  detail: string;
  value?: string;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Free space below this fraction of the volume is worth planning around. */
const DISK_WARNING_FRACTION = 0.15;

/** A daily backup that has not run in 26h has missed one; 48h has missed two. */
const BACKUP_WARNING_HOURS = 26;
const BACKUP_CRITICAL_HOURS = 48;

/** A restore that has not been rehearsed this quarter is a restore nobody has proved. */
const RESTORE_DRILL_WARNING_DAYS = 90;

/** Enough failures to mean something systemic rather than a few bad files. */
const FAILED_UPLOAD_WARNING_COUNT = 20;

/**
 * A queue this long is not "some large uploads are still moving" — it is a backlog.
 * Deliberately generous: a busy afternoon of big datasets should not raise an alert.
 */
const DRIVE_QUEUE_WARNING_COUNT = 50;

export function evaluateDisk(
  capacity: { totalBytes: number; freeBytes: number } | null,
  minFreeBytes: number,
  minFreeGb: number,
): SystemCheck {
  if (!capacity) {
    return {
      key: 'disk',
      label: 'Storage volume',
      severity: 'warning',
      detail: 'Capacity could not be read from the storage volume.',
    };
  }

  const freePercent = capacity.totalBytes > 0 ? capacity.freeBytes / capacity.totalBytes : null;
  const value = `${formatGb(capacity.freeBytes)} free${
    freePercent !== null ? ` (${(freePercent * 100).toFixed(1)}%)` : ''
  }`;

  // Below the floor, uploads are *already* being refused. That is an outage, not a warning.
  if (capacity.freeBytes < minFreeBytes) {
    return {
      key: 'disk',
      label: 'Storage volume',
      severity: 'critical',
      detail: `Free space is below the ${minFreeGb} GB floor. Uploads are being refused.`,
      value,
    };
  }

  if (freePercent !== null && freePercent < DISK_WARNING_FRACTION) {
    return {
      key: 'disk',
      label: 'Storage volume',
      severity: 'warning',
      detail: 'Less than 15% of the volume is free. Plan capacity now rather than at 100%.',
      value,
    };
  }

  return {
    key: 'disk',
    label: 'Storage volume',
    severity: 'ok',
    detail: 'Free space is comfortable.',
    value,
  };
}

/**
 * Backups, judged in three separate ways, because they fail in three separate ways:
 * the job stopped running, the job ran and failed, or the job succeeded and left the
 * only copy on the machine it is supposed to protect against losing.
 */
export function evaluateBackup(status: BackupStatus, now: Date = new Date()): SystemCheck[] {
  const checks: SystemCheck[] = [];
  const ageHours = status.finishedAt
    ? (now.getTime() - status.finishedAt.getTime()) / HOUR_MS
    : null;
  const age = ageHours !== null ? `${Math.round(ageHours)}h ago` : undefined;

  if (!status.finishedAt || status.ok === null) {
    checks.push({
      key: 'backup',
      label: 'Backups',
      severity: 'critical',
      detail:
        'No backup has ever reported success. Local storage on one server with no backup is one disk failure from total loss.',
    });
  } else if (status.ok === false) {
    checks.push({
      key: 'backup',
      label: 'Backups',
      severity: 'critical',
      detail: `The last backup run failed: ${status.detail || 'no detail recorded'}`,
      ...(age ? { value: age } : {}),
    });
  } else if (ageHours !== null && ageHours > BACKUP_CRITICAL_HOURS) {
    checks.push({
      key: 'backup',
      label: 'Backups',
      severity: 'critical',
      detail: 'The last successful backup is more than two days old. The schedule has stopped.',
      ...(age ? { value: age } : {}),
    });
  } else if (ageHours !== null && ageHours > BACKUP_WARNING_HOURS) {
    checks.push({
      key: 'backup',
      label: 'Backups',
      severity: 'warning',
      detail: 'A daily backup appears to have been missed.',
      ...(age ? { value: age } : {}),
    });
  } else {
    checks.push({
      key: 'backup',
      label: 'Backups',
      severity: 'ok',
      detail: status.offsite
        ? 'Backed up and copied off-server.'
        : 'Backed up — but the copy is on this server only.',
      ...(age ? { value: age } : {}),
    });
  }

  // Reported separately from the run itself: a backup that succeeded and stayed on the
  // same disk is the failure mode the whole backup design exists to prevent.
  if (status.finishedAt && !status.offsite) {
    checks.push({
      key: 'backup_offsite',
      label: 'Off-server copy',
      severity: 'warning',
      detail:
        'BACKUP_OFFSITE_TARGET is not configured, so the only backup lives on the same machine as the data it protects.',
    });
  }

  // `restic check` reads the repository back. Without it, "the backup ran" only means
  // the job exited zero.
  if (status.ok === true && !status.verified) {
    checks.push({
      key: 'backup_verified',
      label: 'Backup integrity check',
      severity: 'warning',
      detail:
        'The last backup completed without a repository integrity check, so the snapshot is unverified.',
    });
  }

  return checks;
}

/**
 * Whether anybody has actually restored from these backups.
 *
 * An untested backup is a hypothesis. This is the check that turns Phase 11's "restore
 * testing" from a line in a runbook into something the dashboard nags about.
 */
export function evaluateRestoreDrill(
  status: RestoreDrillStatus,
  now: Date = new Date(),
): SystemCheck {
  if (status.ok === false) {
    return {
      key: 'restore_drill',
      label: 'Restore drill',
      severity: 'critical',
      detail: `The last restore drill failed: ${status.detail || 'no detail recorded'}. The backups cannot be assumed restorable.`,
    };
  }

  if (!status.finishedAt || status.ok === null) {
    return {
      key: 'restore_drill',
      label: 'Restore drill',
      severity: 'warning',
      detail:
        'No restore has ever been rehearsed. Run docker/backup/verify-restore.sh — an untested backup is an assumption.',
    };
  }

  const ageDays = (now.getTime() - status.finishedAt.getTime()) / DAY_MS;
  const value = `${Math.round(ageDays)}d ago`;

  if (ageDays > RESTORE_DRILL_WARNING_DAYS) {
    return {
      key: 'restore_drill',
      label: 'Restore drill',
      severity: 'warning',
      detail: 'The last successful restore drill is more than 90 days old.',
      value,
    };
  }

  return {
    key: 'restore_drill',
    label: 'Restore drill',
    severity: 'ok',
    detail:
      status.filesVerified !== null
        ? `Restored and verified ${status.filesVerified} stored objects against their recorded checksums.`
        : 'A restore has been rehearsed successfully.',
    value,
  };
}

export function evaluateUploads(counts: {
  quarantined: number;
  failed: number;
  rejected: number;
}): SystemCheck {
  const severity: Severity =
    counts.quarantined > 0 || counts.failed > FAILED_UPLOAD_WARNING_COUNT ? 'warning' : 'ok';

  return {
    key: 'uploads',
    label: 'Upload queue',
    severity,
    detail:
      counts.quarantined > 0
        ? 'Files are sitting in quarantine and need a decision.'
        : counts.failed > FAILED_UPLOAD_WARNING_COUNT
          ? 'A large number of uploads have failed. Check the storage volume and the scanner.'
          : 'Nothing is stuck.',
    value: `${counts.quarantined} quarantined · ${counts.failed} failed · ${counts.rejected} rejected`,
  };
}

export function evaluateMalwareScanning(input: {
  enabled: boolean;
  name: string;
  reachable: boolean;
  failClosed: boolean;
}): SystemCheck {
  if (!input.enabled) {
    return {
      key: 'malware',
      label: 'Malware scanning',
      severity: 'warning',
      detail:
        'No antivirus is configured. Uploads are checked for type and signature but not scanned for malware.',
    };
  }

  if (!input.reachable) {
    return {
      key: 'malware',
      label: 'Malware scanning',
      severity: 'critical',
      detail: input.failClosed
        ? 'The scanner is unreachable and uploads are being refused (fail-closed).'
        : 'The scanner is unreachable and uploads are being accepted unscanned (fail-open).',
    };
  }

  return {
    key: 'malware',
    label: 'Malware scanning',
    severity: 'ok',
    detail: `${input.name} is reachable and scanning every upload before it is stored.`,
  };
}

/**
 * Google Shared Drive storage.
 *
 * The severity turns on one question: **is anything relying on it yet?** While new content
 * still goes to local storage, a broken Drive connection stops the migration and nothing
 * else, and calling that critical would train administrators to ignore the one signal that
 * will matter once the default flips. Once Drive *is* the default, the same failure means
 * uploads are being refused, and it becomes critical.
 *
 * An inline private key in production is reported as a warning here rather than refused at
 * boot: refusing would take down a running deployment over a key-handling preference, and
 * the operator who set it needs to be told, not locked out.
 */
export function evaluateDriveStorage(input: {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  isDefaultProvider: boolean;
  driveName: string | null;
  error: string | null;
  warnings: readonly string[];
}): SystemCheck {
  const label = 'Google Shared Drive';

  if (!input.enabled) {
    return {
      key: 'drive-storage',
      label,
      severity: 'ok',
      detail: 'Not in use. Files are stored on this server.',
      value: 'Off',
    };
  }

  if (!input.configured || !input.connected) {
    return {
      key: 'drive-storage',
      label,
      severity: input.isDefaultProvider ? 'critical' : 'warning',
      detail:
        (input.error ?? 'The Shared Drive could not be reached.') +
        (input.isDefaultProvider
          ? ' New uploads are configured to go here, so they will fail until it is fixed.'
          : ' Existing files are unaffected; migration cannot run until it is fixed.'),
      value: 'Not connected',
    };
  }

  if (input.warnings.length > 0) {
    return {
      key: 'drive-storage',
      label,
      severity: 'warning',
      detail: input.warnings.join(' '),
      value: input.driveName ?? 'Connected',
    };
  }

  return {
    key: 'drive-storage',
    label,
    severity: 'ok',
    detail: input.isDefaultProvider
      ? 'Connected. New files are stored here.'
      : 'Connected. New files still go to this server; existing files are served from wherever they are stored.',
    value: input.driveName ?? 'Connected',
  };
}

/**
 * Files uploaded but not yet moved to the Shared Drive.
 *
 * A non-zero queue is normal and self-clearing: large uploads are always queued rather than
 * transferred during the request. What matters is whether it is *draining*. A backlog that
 * keeps growing means Drive has been unreachable for a while, and the consequence is not
 * lost data — every one of those files is complete and readable from local storage — but
 * local disk filling with copies that were supposed to have moved on.
 *
 * So this is never critical. Nothing is broken for anybody using the application; something
 * is broken for the administrator, and they are the one reading this page.
 */
export function evaluateDriveTransferQueue(input: {
  enabled: boolean;
  isDefaultProvider: boolean;
  pending: number;
}): SystemCheck {
  const label = 'Files waiting for the Shared Drive';

  if (!input.enabled || !input.isDefaultProvider) {
    return {
      key: 'drive-queue',
      label,
      severity: 'ok',
      detail: 'New files are stored on this server, so nothing is waiting to move.',
      value: 'n/a',
    };
  }

  if (input.pending === 0) {
    return {
      key: 'drive-queue',
      label,
      severity: 'ok',
      detail: 'Everything uploaded has reached the Shared Drive.',
      value: '0',
    };
  }

  // Large uploads are queued by design, so a small number is the steady state rather than
  // a problem. The threshold is about a backlog that is not clearing.
  const severity: Severity = input.pending >= DRIVE_QUEUE_WARNING_COUNT ? 'warning' : 'ok';

  return {
    key: 'drive-queue',
    label,
    severity,
    detail:
      severity === 'warning'
        ? 'These files are safe and employees can open them — they are still on this server. ' +
          'They have not reached the Shared Drive, which usually means it has been unreachable.'
        : 'Large uploads move to the Shared Drive shortly after they finish. This clears itself.',
    value: String(input.pending),
  };
}

/**
 * Approvals that stopped holding because the document changed after being signed off.
 *
 * A warning, never critical, and never `ok` while the count is non-zero. Nothing is broken
 * and nothing is lost — the file is intact, the approval history is intact, and the file has
 * correctly gone back to needing review. But an approved document changing is exactly the
 * event a research organization must not let pass unnoticed, so it stays visible on this
 * page until somebody has dealt with it.
 *
 * It clears when the file is reviewed again, not on a timer.
 */
export function evaluateApprovalIntegrity(input: {
  enabled: boolean;
  superseded: number;
}): SystemCheck {
  const label = 'Approved documents that changed';

  if (!input.enabled) {
    return {
      key: 'approval-integrity',
      label,
      severity: 'ok',
      detail:
        'Approved files are stored on this server and cannot change once approved.',
      value: 'n/a',
    };
  }

  if (input.superseded === 0) {
    return {
      key: 'approval-integrity',
      label,
      severity: 'ok',
      detail: 'Every approved document still matches what was approved.',
      value: '0',
    };
  }

  return {
    key: 'approval-integrity',
    label,
    severity: 'warning',
    detail:
      input.superseded === 1
        ? 'One approved document has been changed in the Shared Drive since it was approved. ' +
          'It has gone back to needing review and the owner has been told.'
        : `${input.superseded} approved documents have been changed in the Shared Drive since they were ` +
          'approved. They have gone back to needing review and their owners have been told.',
    value: String(input.superseded),
  };
}

/**
 * Whether the application is still hearing about changes made directly in the Shared Drive.
 *
 * Two failure modes, and the first is the dangerous one because it looks like success:
 *
 *   • **Synchronization has stopped.** Every poll returns nothing when nobody is polling.
 *     The application goes on serving a picture of the Drive that is quietly getting older,
 *     and no page anywhere looks wrong. Only the *age* of the last successful poll reveals
 *     it, which is why this check is about a clock rather than about an error.
 *
 *   • **Conflicts have accumulated.** Files moved or folders renamed directly in Drive, which
 *     this application deliberately does not adopt. Each one is a place where the two systems
 *     disagree and a person has to decide.
 *
 * Neither is critical. Nothing is broken for anybody *using* the application — the files all
 * open, the permissions all hold. It is broken for the administrator, and they are the one
 * reading this page.
 */
export function evaluateDriveSync(input: {
  enabled: boolean;
  everRan: boolean;
  minutesSinceLastPoll: number | null;
  intervalMinutes: number;
  conflicts: number;
  consecutiveFailures: number;
}): SystemCheck {
  const label = 'Shared Drive synchronization';

  if (!input.enabled) {
    return {
      key: 'drive-sync',
      label,
      severity: 'ok',
      detail: 'Files are stored on this server, so there is nothing to synchronize.',
      value: 'n/a',
    };
  }

  if (!input.everRan) {
    return {
      key: 'drive-sync',
      label,
      severity: 'warning',
      detail:
        'Never run. Changes made directly in the company Shared Drive will not be noticed ' +
        'until `npm run drive:sync` is scheduled.',
      value: 'never',
    };
  }

  // Two missed intervals rather than one: a single late run is a slow poll, not a stopped
  // scheduler, and a check that cries wolf on ordinary jitter gets ignored when it matters.
  const stalled =
    input.minutesSinceLastPoll !== null &&
    input.minutesSinceLastPoll > Math.max(input.intervalMinutes * 3, 30);

  if (stalled) {
    return {
      key: 'drive-sync',
      label,
      severity: 'warning',
      detail:
        `The last successful run was ${input.minutesSinceLastPoll} minutes ago, well past the ` +
        `expected ${input.intervalMinutes}. Changes made directly in the Shared Drive are not ` +
        'being picked up.',
      value: `${input.minutesSinceLastPoll} min ago`,
    };
  }

  if (input.consecutiveFailures > 0) {
    return {
      key: 'drive-sync',
      label,
      severity: 'warning',
      detail: `${input.consecutiveFailures} run(s) in a row have failed. Nothing is lost — the cursor only advances on success.`,
      value: 'failing',
    };
  }

  if (input.conflicts > 0) {
    return {
      key: 'drive-sync',
      label,
      severity: 'warning',
      detail:
        `${input.conflicts} item(s) have been changed in the Shared Drive in a way this ` +
        'application does not apply on its own — usually a file moved to a different folder. ' +
        'Each one needs a decision.',
      value: `${input.conflicts} to review`,
    };
  }

  return {
    key: 'drive-sync',
    label,
    severity: 'ok',
    detail: 'Running, and the two are in step.',
    value:
      input.minutesSinceLastPoll === null ? 'up to date' : `${input.minutesSinceLastPoll} min ago`,
  };
}

/**
 * Local copies kept after migration, and how much disk they are holding.
 *
 * Always `ok`, never a warning, and that is a deliberate choice rather than an oversight.
 * These files are not a problem — they are the rollback mechanism and Phase 4's fallback for
 * a missing Drive object, doing exactly what they were kept for. Flagging them would invite
 * an administrator to clear them for the sake of a green tick, which is precisely the
 * decision §18 wants made carefully.
 *
 * So this reports a number and says what it is for. Disk pressure has its own check, which is
 * the one that should prompt action.
 */
export function evaluateRetainedLocalCopies(input: {
  enabled: boolean;
  retained: number;
  retainedBytes: number;
  eligible: number;
  eligibleBytes: number;
}): SystemCheck {
  const label = 'Local copies kept after migration';

  if (!input.enabled || input.retained === 0) {
    return {
      key: 'local-copies',
      label,
      severity: 'ok',
      detail: input.enabled
        ? 'Nothing is being kept — either nothing has migrated yet, or the copies have been cleared.'
        : 'Files are stored on this server, so there is nothing to keep a second copy of.',
      value: input.enabled ? '0' : 'n/a',
    };
  }

  const detail =
    input.eligible > 0
      ? `${formatGb(input.retainedBytes)} kept so a migration can still be undone and so files ` +
        `stay readable if a Drive copy goes missing. ${formatGb(input.eligibleBytes)} across ` +
        `${input.eligible} file(s) is now past its retention window and could be archived.`
      : `${formatGb(input.retainedBytes)} kept so a migration can still be undone and so files ` +
        'stay readable if a Drive copy goes missing. None is past its retention window yet.';

  return { key: 'local-copies', label, severity: 'ok', detail, value: formatGb(input.retainedBytes) };
}

export function evaluateDatabase(health: {
  status: string;
  latencyMs?: number;
  error?: string;
}): SystemCheck {
  return {
    key: 'database',
    label: 'Database',
    severity: health.status === 'ok' ? 'ok' : 'critical',
    detail: health.status === 'ok' ? 'Connected and responding.' : (health.error ?? 'Not reachable.'),
    ...(health.latencyMs !== undefined ? { value: `${health.latencyMs} ms` } : {}),
  };
}

/** The worst individual verdict wins. Averaging health checks hides the one that matters. */
export function overallSeverity(checks: readonly SystemCheck[]): Severity {
  if (checks.some((check) => check.severity === 'critical')) return 'critical';
  if (checks.some((check) => check.severity === 'warning')) return 'warning';
  return 'ok';
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
