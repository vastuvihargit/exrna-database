/**
 * Operational judgement.
 *
 * These tests are about a single question: when something is quietly going wrong, does
 * the system say so? Most of the failures Phase 11 exists to prevent are not crashes —
 * they are conditions that look like silence. A backup job that stopped three weeks ago
 * produces exactly the same dashboard as one that ran an hour ago, unless something
 * deliberately checks the age and complains.
 *
 * So the cases below are weighted towards the *ambiguous* readings: no status file at
 * all, a status file that says nothing useful, a backup that succeeded but never left
 * the building. Each of those has an obvious wrong answer ("no news is good news") and
 * these assert the right one.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  evaluateApprovalIntegrity,
  evaluateBackup,
  evaluateDatabase,
  evaluateDisk,
  evaluateDriveSync,
  evaluateMalwareScanning,
  evaluateRestoreDrill,
  evaluateRetainedLocalCopies,
  evaluateUploads,
  overallSeverity,
  type SystemCheck,
} from '@/server/services/system-checks';
import {
  readBackupStatus,
  readRestoreDrillStatus,
  type BackupStatus,
  type RestoreDrillStatus,
} from '@/server/storage/backup-status';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const GB = 1024 ** 3;

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 3_600_000);
}

function backup(overrides: Partial<BackupStatus> = {}): BackupStatus {
  return {
    finishedAt: hoursAgo(2),
    ok: true,
    offsite: true,
    verified: true,
    detail: '',
    snapshotId: 'abc123',
    durationSeconds: 300,
    missing: false,
    ...overrides,
  };
}

function drill(overrides: Partial<RestoreDrillStatus> = {}): RestoreDrillStatus {
  return {
    finishedAt: daysAgo(3),
    ok: true,
    detail: '',
    filesVerified: 25,
    documentsRestored: 5000,
    missing: false,
    ...overrides,
  };
}

function find(checks: readonly SystemCheck[], key: string): SystemCheck {
  const check = checks.find((entry) => entry.key === key);
  expect(check, `expected a check with key "${key}"`).toBeDefined();
  return check!;
}

describe('disk checks', () => {
  it('treats being below the free-space floor as critical, not a warning', () => {
    // Below the floor uploads are already being refused. That is an outage in progress.
    const check = evaluateDisk({ totalBytes: 500 * GB, freeBytes: 2 * GB }, 10 * GB, 10);
    expect(check.severity).toBe('critical');
    expect(check.detail).toContain('refused');
  });

  it('warns while there is still time to act', () => {
    const check = evaluateDisk({ totalBytes: 500 * GB, freeBytes: 40 * GB }, 10 * GB, 10);
    expect(check.severity).toBe('warning');
  });

  it('is content with comfortable headroom', () => {
    const check = evaluateDisk({ totalBytes: 500 * GB, freeBytes: 300 * GB }, 10 * GB, 10);
    expect(check.severity).toBe('ok');
  });

  it('warns rather than reporting health when capacity cannot be read', () => {
    // "I could not measure it" must never render as "it is fine".
    expect(evaluateDisk(null, 10 * GB, 10).severity).toBe('warning');
  });
});

describe('backup checks', () => {
  it('reports a backup that has never run as critical', () => {
    const checks = evaluateBackup(backup({ finishedAt: null, ok: null, missing: true }), NOW);
    expect(find(checks, 'backup').severity).toBe('critical');
  });

  it('reports an explicitly failed run as critical and quotes the reason', () => {
    const checks = evaluateBackup(
      backup({ ok: false, detail: 'Backup failed during stage offsite_copy' }),
      NOW,
    );
    const check = find(checks, 'backup');
    expect(check.severity).toBe('critical');
    expect(check.detail).toContain('offsite_copy');
  });

  it('escalates from a missed daily backup to a stopped schedule', () => {
    expect(find(evaluateBackup(backup({ finishedAt: hoursAgo(30) }), NOW), 'backup').severity).toBe(
      'warning',
    );
    expect(find(evaluateBackup(backup({ finishedAt: hoursAgo(60) }), NOW), 'backup').severity).toBe(
      'critical',
    );
  });

  it('warns separately when the only copy is on the machine it protects', () => {
    // The single most important rule in the backup design, so it gets its own check
    // rather than a footnote on a green one.
    const checks = evaluateBackup(backup({ offsite: false }), NOW);
    expect(find(checks, 'backup').severity).toBe('ok');
    expect(find(checks, 'backup_offsite').severity).toBe('warning');
  });

  it('warns when a run completed without verifying the repository', () => {
    const checks = evaluateBackup(backup({ verified: false }), NOW);
    expect(find(checks, 'backup_verified').severity).toBe('warning');
  });

  it('adds no extra noise when everything is genuinely fine', () => {
    const checks = evaluateBackup(backup(), NOW);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.severity).toBe('ok');
  });
});

describe('restore drill checks', () => {
  it('warns when no restore has ever been rehearsed', () => {
    // An untested backup is a hypothesis, and this is the check that says so out loud.
    const check = evaluateRestoreDrill(drill({ finishedAt: null, ok: null, missing: true }), NOW);
    expect(check.severity).toBe('warning');
    expect(check.detail).toContain('untested');
  });

  it('treats a failed drill as critical', () => {
    // Worse than never having tried: it is positive evidence the backups do not restore.
    const check = evaluateRestoreDrill(drill({ ok: false, detail: '3 objects corrupted' }), NOW);
    expect(check.severity).toBe('critical');
    expect(check.detail).toContain('corrupted');
  });

  it('warns once a passing drill goes stale', () => {
    expect(evaluateRestoreDrill(drill({ finishedAt: daysAgo(120) }), NOW).severity).toBe('warning');
    expect(evaluateRestoreDrill(drill({ finishedAt: daysAgo(10) }), NOW).severity).toBe('ok');
  });
});

describe('upload queue and scanning checks', () => {
  it('flags anything sitting in quarantine', () => {
    const check = evaluateUploads({ quarantined: 1, failed: 0, rejected: 0 });
    expect(check.severity).toBe('warning');
    expect(check.detail).toContain('quarantine');
  });

  it('ignores a handful of ordinary upload failures', () => {
    expect(evaluateUploads({ quarantined: 0, failed: 3, rejected: 9 }).severity).toBe('ok');
  });

  it('warns when no antivirus is configured at all', () => {
    const check = evaluateMalwareScanning({
      enabled: false,
      name: 'none',
      reachable: false,
      failClosed: false,
    });
    expect(check.severity).toBe('warning');
  });

  it('is critical when a configured scanner is unreachable, either way it is configured', () => {
    // Fail-closed: uploads are being refused — an outage.
    // Fail-open: uploads are being stored unscanned — a security hole.
    // Both are critical; only the explanation differs.
    const failClosed = evaluateMalwareScanning({
      enabled: true,
      name: 'ClamAV',
      reachable: false,
      failClosed: true,
    });
    const failOpen = evaluateMalwareScanning({
      enabled: true,
      name: 'ClamAV',
      reachable: false,
      failClosed: false,
    });

    expect(failClosed.severity).toBe('critical');
    expect(failClosed.detail).toContain('refused');
    expect(failOpen.severity).toBe('critical');
    expect(failOpen.detail).toContain('unscanned');
  });
});

describe('overall severity', () => {
  it('takes the worst verdict rather than an average', () => {
    const checks: SystemCheck[] = [
      { key: 'a', label: 'A', severity: 'ok', detail: '' },
      { key: 'b', label: 'B', severity: 'ok', detail: '' },
      { key: 'c', label: 'C', severity: 'critical', detail: '' },
    ];
    expect(overallSeverity(checks)).toBe('critical');
  });

  it('reports a database that is down as critical', () => {
    expect(evaluateDatabase({ status: 'error', error: 'connection refused' }).severity).toBe(
      'critical',
    );
    expect(evaluateDatabase({ status: 'ok', latencyMs: 3 }).severity).toBe('ok');
  });
});

describe('reading the backup status files', () => {
  let directory: string;

  beforeAll(async () => {
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'biotech-backup-status-'));
  });

  afterAll(async () => {
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  });

  it('reports an absent file as "never ran", not as healthy', async () => {
    const status = await readBackupStatus(directory);
    expect(status.missing).toBe(true);
    expect(status.ok).toBeNull();
    expect(status.finishedAt).toBeNull();
    // And the evaluation layer must then treat it as critical.
    expect(find(evaluateBackup(status, NOW), 'backup').severity).toBe('critical');
  });

  it('parses a real success record', async () => {
    await fsp.writeFile(
      path.join(directory, 'last-backup.json'),
      JSON.stringify({
        schemaVersion: 1,
        finishedAt: '2026-07-30T02:20:00Z',
        ok: true,
        offsite: true,
        verified: true,
        snapshotId: 'a1b2c3d4',
        durationSeconds: 412,
        detail: 'Backed up, verified and copied off-server.',
      }),
    );

    const status = await readBackupStatus(directory);
    expect(status.ok).toBe(true);
    expect(status.offsite).toBe(true);
    expect(status.verified).toBe(true);
    expect(status.snapshotId).toBe('a1b2c3d4');
    expect(status.finishedAt?.toISOString()).toBe('2026-07-30T02:20:00.000Z');
  });

  it('treats an unparseable status file as "never ran" rather than trusting it', async () => {
    // A backup job that writes garbage has not proved it backed anything up. The unsafe
    // reading here would be to default `ok` to true and let a broken job look healthy.
    await fsp.writeFile(path.join(directory, 'last-backup.json'), '{ this is not json');
    const status = await readBackupStatus(directory);
    expect(status.ok).toBeNull();
    expect(status.missing).toBe(true);
  });

  it('ignores a status file that is implausibly large', async () => {
    // A few hundred bytes is what the job writes. Anything else is not a status file,
    // and this read happens while rendering an admin page.
    await fsp.writeFile(path.join(directory, 'last-backup.json'), 'x'.repeat(200_000));
    expect((await readBackupStatus(directory)).missing).toBe(true);
  });

  it('rejects a JSON array where an object was expected', async () => {
    await fsp.writeFile(path.join(directory, 'last-backup.json'), '[{"ok":true}]');
    expect((await readBackupStatus(directory)).ok).toBeNull();
  });

  it('reads the restore drill record separately from the backup record', async () => {
    await fsp.writeFile(
      path.join(directory, 'last-restore-drill.json'),
      JSON.stringify({
        finishedAt: '2026-07-27T03:40:00Z',
        ok: true,
        filesVerified: 25,
        documentsRestored: 18342,
        detail: 'Restored and verified.',
      }),
    );

    const status = await readRestoreDrillStatus(directory);
    expect(status.ok).toBe(true);
    expect(status.filesVerified).toBe(25);
    expect(status.documentsRestored).toBe(18342);
    expect(evaluateRestoreDrill(status, new Date('2026-07-30T12:00:00Z')).severity).toBe('ok');
  });

  it('does not confuse a bad timestamp for a successful run', async () => {
    await fsp.writeFile(
      path.join(directory, 'last-restore-drill.json'),
      JSON.stringify({ finishedAt: 'not-a-date', ok: true }),
    );
    const status = await readRestoreDrillStatus(directory);
    expect(status.finishedAt).toBeNull();
    // ok:true with no usable timestamp is not evidence of a recent drill.
    expect(evaluateRestoreDrill(status, NOW).severity).toBe('warning');
  });
});

/**
 * An approved document changing is the one condition in this file that is not about a job
 * quietly failing — it is about a *record* quietly becoming untrue. The wrong answer is the
 * same shape as everywhere else in this suite ("nothing crashed, so nothing to report"), and
 * these assert the right one.
 */
describe('approval integrity', () => {
  it('says nothing is at risk on a deployment without Drive', () => {
    const check = evaluateApprovalIntegrity({ enabled: false, superseded: 0 });
    expect(check.severity).toBe('ok');
    // Not "0" — the honest answer is that the question does not arise. Local content is
    // immutable once approved, so there is nothing that could have drifted.
    expect(check.value).toBe('n/a');
  });

  it('is ok when every approved document still matches', () => {
    expect(evaluateApprovalIntegrity({ enabled: true, superseded: 0 }).severity).toBe('ok');
  });

  it('warns while any approval is stale, however few', () => {
    const one = evaluateApprovalIntegrity({ enabled: true, superseded: 1 });
    expect(one.severity).toBe('warning');
    expect(one.detail).toContain('One approved document');

    // No threshold below which this is acceptable: a single changed approved document in a
    // regulated research record is the event, not a rounding error.
    expect(evaluateApprovalIntegrity({ enabled: true, superseded: 12 }).severity).toBe('warning');
  });

  it('never reports it as critical — nothing is broken for anybody using the application', () => {
    const check = evaluateApprovalIntegrity({ enabled: true, superseded: 99 });
    expect(check.severity).not.toBe('critical');
    expect(check.value).toBe('99');
  });
});

/**
 * Synchronization has a failure mode that looks exactly like success: when nobody is polling,
 * every poll returns nothing. The application goes on serving a picture of the Shared Drive
 * that is quietly getting older and no page anywhere looks wrong. Only the *age* of the last
 * successful run reveals it, which is why these cases are about a clock.
 */
describe('drive synchronization', () => {
  const base = {
    enabled: true,
    everRan: true,
    minutesSinceLastPoll: 5,
    intervalMinutes: 15,
    conflicts: 0,
    consecutiveFailures: 0,
  };

  it('says the question does not arise without Drive', () => {
    const check = evaluateDriveSync({ ...base, enabled: false });
    expect(check.severity).toBe('ok');
    expect(check.value).toBe('n/a');
  });

  it('warns when it has never run at all', () => {
    // The state a deployment lands in by setting the interval and forgetting the cron job.
    const check = evaluateDriveSync({ ...base, everRan: false, minutesSinceLastPoll: null });
    expect(check.severity).toBe('warning');
    expect(check.detail).toContain('drive:sync');
  });

  it('tolerates ordinary lateness but not a stopped scheduler', () => {
    // One late run is a slow poll. A check that cries wolf on jitter gets ignored when it
    // matters, so the threshold is three intervals rather than one.
    expect(evaluateDriveSync({ ...base, minutesSinceLastPoll: 20 }).severity).toBe('ok');
    expect(evaluateDriveSync({ ...base, minutesSinceLastPoll: 90 }).severity).toBe('warning');
  });

  it('has a floor under the threshold, so a one-minute interval is not permanently red', () => {
    expect(evaluateDriveSync({ ...base, intervalMinutes: 1, minutesSinceLastPoll: 5 }).severity).toBe('ok');
  });

  it('reports repeated failures, and says nothing is lost', () => {
    const check = evaluateDriveSync({ ...base, consecutiveFailures: 4 });
    expect(check.severity).toBe('warning');
    expect(check.detail).toContain('cursor only advances on success');
  });

  it('reports conflicts waiting for a decision', () => {
    const check = evaluateDriveSync({ ...base, conflicts: 3 });
    expect(check.severity).toBe('warning');
    expect(check.value).toBe('3 to review');
  });

  it('is never critical — every file still opens and every permission still holds', () => {
    expect(
      evaluateDriveSync({ ...base, conflicts: 50, consecutiveFailures: 9, minutesSinceLastPoll: 5000 })
        .severity,
    ).not.toBe('critical');
  });
});

/**
 * Retained local copies are the one thing on this page that must *not* be nagged about.
 * They are the rollback mechanism and the fallback for a missing Drive object, doing exactly
 * what they were kept for. A warning here would invite an administrator to clear them for the
 * sake of a green tick — which is the single decision this whole retention design is trying
 * to make people take slowly.
 */
describe('retained local copies', () => {
  const base = { enabled: true, retained: 40, retainedBytes: 12 * 1024 ** 3, eligible: 0, eligibleBytes: 0 };

  it('is never a warning, however much is held', () => {
    expect(evaluateRetainedLocalCopies(base).severity).toBe('ok');
    expect(
      evaluateRetainedLocalCopies({ ...base, retained: 900_000, retainedBytes: 400 * 1024 ** 4 })
        .severity,
    ).toBe('ok');
  });

  it('says the question does not arise without Drive', () => {
    expect(evaluateRetainedLocalCopies({ ...base, enabled: false }).value).toBe('n/a');
  });

  it('explains what the copies are for, not just how many there are', () => {
    const check = evaluateRetainedLocalCopies(base);
    expect(check.detail).toContain('undone');
    expect(check.detail).toContain('None is past its retention window yet.');
  });

  it('mentions what could be reclaimed once the window has passed', () => {
    const check = evaluateRetainedLocalCopies({
      ...base,
      eligible: 12,
      eligibleBytes: 5 * 1024 ** 3,
    });
    expect(check.severity).toBe('ok');
    expect(check.detail).toContain('12 file(s)');
    expect(check.detail).toContain('could be archived');
  });
});
