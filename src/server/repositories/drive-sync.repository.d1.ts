/**
 * The D1 Drive-sync cursor repository.
 *
 * Small, and with two places where the SQL is doing something the Mongo query did for free.
 *
 * ── `ensureState` is an upsert with a returning read, not find-then-create ──────────────
 *
 * Same reason as MongoDB's: two workers starting at the same moment would each create a row and
 * `ux_drive_sync_states` would fail the second, turning a harmless race into a failed sync run.
 * `ON CONFLICT DO NOTHING` followed by a SELECT gets there — the insert is a no-op for the
 * loser, and both then read the same row.
 *
 * `DO NOTHING` rather than `DO UPDATE`: this call must never disturb an existing cursor. An
 * upsert that reset `state` to `'idle'` would clear the `failed` flag an operator is looking at,
 * on every poll.
 *
 * ── `advanceCursor` reads its own effect back ───────────────────────────────────────────
 *
 * The conditional UPDATE is the concurrency guard, and the caller needs to know whether it
 * applied. `meta.changes` answers that directly here — there are no cascades on this table, so
 * unlike the activity and comment sweeps (module 14 §4.2) the count means what it says.
 */
import { sql } from 'drizzle-orm';
import { getD1 } from '@/server/db/d1-context';
import type { Database } from '@/server/db/d1';
import type {
  AdvanceCursorInput,
  DriveSyncRepository,
  DriveSyncRunState,
  DriveSyncStateRecord,
  DriveSyncStateUpdate,
} from './drive-sync.repository.contract';

interface StateRow {
  id: string;
  organization_id: string;
  shared_drive_id: string;
  state: string;
  start_page_token: string | null;
  token_expired_at: string | null;
  last_poll_at: string | null;
  last_successful_poll_at: string | null;
  last_full_reconcile_at: string | null;
  changes_applied: number;
  conflicts_detected: number;
  consecutive_failures: number;
  last_error: string | null;
  updated_at: string;
}

function date(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toRecord(row: StateRow): DriveSyncStateRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sharedDriveId: row.shared_drive_id,
    state: row.state as DriveSyncRunState,
    startPageToken: row.start_page_token,
    tokenExpiredAt: date(row.token_expired_at),
    lastPollAt: date(row.last_poll_at),
    lastSuccessfulPollAt: date(row.last_successful_poll_at),
    lastFullReconcileAt: date(row.last_full_reconcile_at),
    changesApplied: row.changes_applied,
    conflictsDetected: row.conflicts_detected,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    updatedAt: new Date(row.updated_at),
  };
}

async function selectState(
  db: Database,
  organizationId: string,
  sharedDriveId: string,
): Promise<StateRow | null> {
  const rows = await db.all<StateRow>(sql`
    SELECT * FROM drive_sync_states
     WHERE organization_id = ${organizationId} AND shared_drive_id = ${sharedDriveId}
     LIMIT 1
  `);
  return rows[0] ?? null;
}

export async function ensureState(input: {
  organizationId: string;
  sharedDriveId: string;
}): Promise<DriveSyncStateRecord> {
  const db = await getD1();
  const now = new Date().toISOString();

  await db.run(sql`
    INSERT INTO drive_sync_states
      (id, organization_id, shared_drive_id, state, changes_applied, conflicts_detected,
       consecutive_failures, created_at, updated_at)
    VALUES (${crypto.randomUUID()}, ${input.organizationId}, ${input.sharedDriveId}, 'idle',
            0, 0, 0, ${now}, ${now})
    ON CONFLICT (organization_id, shared_drive_id) DO NOTHING
  `);

  const row = await selectState(db, input.organizationId, input.sharedDriveId);
  if (!row) {
    throw new Error('The Drive sync cursor could not be created or read back');
  }
  return toRecord(row);
}

export async function findState(input: {
  organizationId: string;
  sharedDriveId: string;
}): Promise<DriveSyncStateRecord | null> {
  const row = await selectState(await getD1(), input.organizationId, input.sharedDriveId);
  return row ? toRecord(row) : null;
}

export async function listStates(): Promise<DriveSyncStateRecord[]> {
  const db = await getD1();
  const rows = await db.all<StateRow>(
    sql`SELECT * FROM drive_sync_states ORDER BY updated_at DESC`,
  );
  return rows.map(toRecord);
}

export async function updateState(id: string, update: DriveSyncStateUpdate): Promise<void> {
  const db = await getD1();

  const assignments = [sql`updated_at = ${new Date().toISOString()}`];

  if (update.state !== undefined) assignments.push(sql`state = ${update.state}`);
  if (update.startPageToken !== undefined) {
    assignments.push(sql`start_page_token = ${update.startPageToken}`);
  }
  if (update.tokenExpiredAt !== undefined) {
    assignments.push(sql`token_expired_at = ${iso(update.tokenExpiredAt)}`);
  }
  if (update.lastPollAt !== undefined) {
    assignments.push(sql`last_poll_at = ${iso(update.lastPollAt)}`);
  }
  if (update.lastSuccessfulPollAt !== undefined) {
    assignments.push(sql`last_successful_poll_at = ${iso(update.lastSuccessfulPollAt)}`);
  }
  if (update.lastFullReconcileAt !== undefined) {
    assignments.push(sql`last_full_reconcile_at = ${iso(update.lastFullReconcileAt)}`);
  }
  if (update.lastError !== undefined) assignments.push(sql`last_error = ${update.lastError}`);
  if (update.consecutiveFailures !== undefined) {
    assignments.push(sql`consecutive_failures = ${update.consecutiveFailures}`);
  }
  // Arithmetic inside the statement, for the same reason MongoDB uses `$inc`. Applied after any
  // explicit reset above so a caller that does both — which nothing does — gets the increment.
  if (update.incrementFailures) {
    assignments.push(
      sql`consecutive_failures = consecutive_failures + ${update.incrementFailures}`,
    );
  }

  await db.run(sql`
    UPDATE drive_sync_states SET ${sql.join(assignments, sql`, `)} WHERE id = ${id}
  `);
}

export async function advanceCursor(input: AdvanceCursorInput): Promise<boolean> {
  const db = await getD1();

  /**
   * `IS` rather than `=` on the token comparison.
   *
   * The first advance of a drive's life has `from === null`, and `start_page_token = NULL` is
   * NULL in SQL, never true — so an `=` comparison would silently never match and the very
   * first cursor would never be written. `IS` is SQLite's null-safe equality and handles both
   * the null and non-null case in one statement.
   */
  const result = await db.run(sql`
    UPDATE drive_sync_states
       SET start_page_token = ${input.to},
           token_expired_at = NULL,
           changes_applied = changes_applied + ${input.appliedDelta},
           conflicts_detected = conflicts_detected + ${input.conflictsDelta},
           updated_at = ${new Date().toISOString()}
     WHERE id = ${input.id} AND start_page_token IS ${input.from}
  `);

  return (result.meta?.changes ?? 0) > 0;
}

export const d1DriveSyncRepository: DriveSyncRepository = {
  ensureState,
  findState,
  listStates,
  updateState,
  advanceCursor,
};
