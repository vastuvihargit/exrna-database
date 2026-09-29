/**
 * The Drive change-feed cursor — the shape both engines implement.
 *
 * One row per Shared Drive, created on first use. Almost everything here exists to protect a
 * single field, `startPageToken`, and the discipline around it:
 *
 *   • It is advanced **after** a page's changes have been applied, never before. A crash
 *     mid-page replays that page, and every change application is idempotent, so replaying
 *     costs a little work and changes nothing. Advancing first would silently skip changes,
 *     and nothing would ever notice.
 *
 *   • `tokenExpiredAt` is not decoration. Drive expires cursors, and a 404 on one is *not*
 *     "no changes" — it means the feed moved past what we last saw and an unknown set of
 *     renames, moves and deletions happened while nobody was looking. Recording it is what
 *     forces a full reconcile instead of a cheerful empty poll.
 *
 * ── Why this module is on the migration list at all ─────────────────────────────────────
 *
 * It is background work, not request-path: nothing a user does reaches it. It still needs a D1
 * implementation, because the sync job runs *in the Worker* — as a cron trigger or a queue
 * consumer — and a Worker cannot open the TCP socket Mongoose needs. Left on MongoDB, Drive
 * synchronization would simply stop after cutover, and the symptom would be renames and
 * deletions made in Drive silently never appearing in the application.
 */

/**
 * Re-exported rather than redeclared.
 *
 * The list already exists on the Mongoose model and the D1 schema imports it from there, so a
 * second copy here would be a third definition that can drift — and the drift would be a state
 * one engine accepts and the other rejects, discovered on a write.
 */
export { DRIVE_SYNC_STATES, type DriveSyncRunState } from '@/server/db/models/drive-sync-state.model';
import type { DriveSyncRunState } from '@/server/db/models/drive-sync-state.model';

export interface DriveSyncStateRecord {
  id: string;
  organizationId: string;
  sharedDriveId: string;
  state: DriveSyncRunState;
  startPageToken: string | null;
  tokenExpiredAt: Date | null;
  lastPollAt: Date | null;
  lastSuccessfulPollAt: Date | null;
  lastFullReconcileAt: Date | null;
  changesApplied: number;
  conflictsDetected: number;
  consecutiveFailures: number;
  lastError: string | null;
  updatedAt: Date;
}

/**
 * The fields a sync run may write, as a closed set.
 *
 * The MongoDB repository took a raw `{ $set, $inc }` document, which has no D1 equivalent and —
 * more to the point — let any caller write any field, including `startPageToken`. That matters
 * because the cursor has exactly one safe way to move: `advanceCursor`, which is conditional.
 * A `$set` that wrote it unconditionally would defeat the concurrency guard without looking
 * like it was doing anything unusual.
 *
 * `startPageToken` is therefore still present here, but only for the two moments where an
 * unconditional write is correct: taking the very first cursor, and taking a fresh one after a
 * full reconcile. Both are documented at their call sites in `drive-sync.service.ts`.
 */
export interface DriveSyncStateUpdate {
  state?: DriveSyncRunState;
  startPageToken?: string | null;
  tokenExpiredAt?: Date | null;
  lastPollAt?: Date | null;
  lastSuccessfulPollAt?: Date | null;
  lastFullReconcileAt?: Date | null;
  lastError?: string | null;
  /** Set to 0 on success; `incrementFailures` is how it goes up. */
  consecutiveFailures?: number;
  /**
   * Applied as an atomic increment on both engines, never a read-modify-write.
   *
   * Two workers polling the same drive would otherwise each read the old count and write their
   * own, and the failure counter — which is what an operator watches to decide whether Drive
   * sync is broken — would under-report exactly when it is being tested.
   */
  incrementFailures?: number;
}

export interface AdvanceCursorInput {
  id: string;
  /** The token the caller believes is current. The write is conditional on it. */
  from: string | null;
  to: string;
  appliedDelta: number;
  conflictsDelta: number;
}

export interface DriveSyncRepository {
  /** The cursor row, created if this drive has never been synchronized. */
  ensureState(input: {
    organizationId: string;
    sharedDriveId: string;
  }): Promise<DriveSyncStateRecord>;

  findState(input: {
    organizationId: string;
    sharedDriveId: string;
  }): Promise<DriveSyncStateRecord | null>;

  /** Every drive's cursor, for the admin monitoring view. There is normally exactly one. */
  listStates(): Promise<DriveSyncStateRecord[]>;

  updateState(id: string, update: DriveSyncStateUpdate): Promise<void>;

  /**
   * Advances the cursor, and only the cursor.
   *
   * Conditional on the token the caller read, so a second worker that polled the same page
   * concurrently cannot wind the cursor backwards. Returns false when that happened, which the
   * caller treats as "somebody else is ahead of us" rather than as an error.
   */
  advanceCursor(input: AdvanceCursorInput): Promise<boolean>;
}
