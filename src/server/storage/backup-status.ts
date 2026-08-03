/**
 * Reading the status files the backup jobs leave behind.
 *
 * This lives in the storage layer for the same reason everything else that opens a file
 * does: `src/server/**` outside this directory never imports `fs`, and an architectural
 * test enforces it. The rule is not bureaucratic — it is what makes "replace local disk
 * with S3" a change to one directory.
 *
 * The application deliberately does not *run* backups. The backup container mounts the
 * data volume read-only, so no bug in this application can damage the copy that protects
 * it. Two small JSON files are the entire channel between them:
 *
 *   last-backup.json        written by docker/backup/backup.sh after every run
 *   last-restore-drill.json written by docker/backup/verify-restore.sh
 *
 * A missing file means "never ran", never "fine". That distinction is the whole point:
 * a backup system that fails silently is indistinguishable from one that was never
 * installed, right up until the moment somebody needs it.
 */
import fsp from 'fs/promises';
import path from 'path';

import { getEnv } from '@/server/config/env';

export const BACKUP_STATUS_FILE = 'last-backup.json';
export const RESTORE_DRILL_STATUS_FILE = 'last-restore-drill.json';

/** A status file is a few hundred bytes. Anything larger is not one. */
const MAX_STATUS_BYTES = 64 * 1024;

export interface BackupStatus {
  /** When the run finished, or null if no run has ever reported. */
  finishedAt: Date | null;
  /** null when nothing has ever been written — distinct from an explicit failure. */
  ok: boolean | null;
  /** Whether the run copied the repository to an off-server target. */
  offsite: boolean;
  /** Whether the run's integrity check (`restic check`) passed. */
  verified: boolean;
  detail: string;
  snapshotId: string | null;
  durationSeconds: number | null;
  /** True when no status file exists at all. */
  missing: boolean;
}

export interface RestoreDrillStatus {
  finishedAt: Date | null;
  ok: boolean | null;
  detail: string;
  /** Objects compared byte-for-byte against their recorded checksum during the drill. */
  filesVerified: number | null;
  /** Documents counted in the restored database. */
  documentsRestored: number | null;
  missing: boolean;
}

export async function readBackupStatus(directory?: string): Promise<BackupStatus> {
  const parsed = await readStatusFile(directory ?? backupDirectory(), BACKUP_STATUS_FILE);

  if (!parsed) {
    return {
      finishedAt: null,
      ok: null,
      offsite: false,
      verified: false,
      detail: 'No backup status file has been written.',
      snapshotId: null,
      durationSeconds: null,
      missing: true,
    };
  }

  return {
    finishedAt: parseDate(parsed.finishedAt),
    ok: typeof parsed.ok === 'boolean' ? parsed.ok : null,
    offsite: parsed.offsite === true,
    verified: parsed.verified === true,
    detail: parseDetail(parsed.detail),
    snapshotId: typeof parsed.snapshotId === 'string' ? parsed.snapshotId.slice(0, 64) : null,
    durationSeconds: parseNumber(parsed.durationSeconds),
    missing: false,
  };
}

export async function readRestoreDrillStatus(directory?: string): Promise<RestoreDrillStatus> {
  const parsed = await readStatusFile(directory ?? backupDirectory(), RESTORE_DRILL_STATUS_FILE);

  if (!parsed) {
    return {
      finishedAt: null,
      ok: null,
      detail: 'No restore drill has ever been recorded.',
      filesVerified: null,
      documentsRestored: null,
      missing: true,
    };
  }

  return {
    finishedAt: parseDate(parsed.finishedAt),
    ok: typeof parsed.ok === 'boolean' ? parsed.ok : null,
    detail: parseDetail(parsed.detail),
    filesVerified: parseNumber(parsed.filesVerified),
    documentsRestored: parseNumber(parsed.documentsRestored),
    missing: false,
  };
}

/** Absolute path of the directory the backup jobs write their status files into. */
export function backupDirectory(): string {
  return getEnv().storageRoots.backups;
}

interface RawStatus {
  finishedAt?: unknown;
  ok?: unknown;
  offsite?: unknown;
  verified?: unknown;
  detail?: unknown;
  snapshotId?: unknown;
  durationSeconds?: unknown;
  filesVerified?: unknown;
  documentsRestored?: unknown;
}

/**
 * Reads and parses one status file.
 *
 * Returns null for *any* reason the file cannot be trusted — absent, unreadable,
 * oversized, not JSON, not an object. The caller turns null into "never ran", which is
 * the safe reading in every one of those cases. A backup job that writes garbage has
 * not proved it backed anything up.
 *
 * Errors are swallowed rather than thrown on purpose: this is read while rendering an
 * operational dashboard, and an unreadable status file must not be the thing that stops
 * an administrator seeing the disk is full.
 */
async function readStatusFile(directory: string, filename: string): Promise<RawStatus | null> {
  const file = path.join(directory, filename);

  try {
    const handle = await fsp.stat(file);
    if (!handle.isFile() || handle.size > MAX_STATUS_BYTES) return null;

    const raw = await fsp.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as RawStatus;
  } catch {
    return null;
  }
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseDetail(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 500) : '';
}
