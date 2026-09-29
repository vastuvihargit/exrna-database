/**
 * Phase 3, module 16 — the Drive change-feed cursor.
 *
 * The last repository reachable from a Worker without a D1 implementation. Small, and worth
 * testing carefully anyway, because every failure mode here is silent:
 *
 *   • **A cursor that winds backwards replays work.** Harmless, because applying a change is
 *     idempotent — but only if the conditional advance actually refuses. If it does not, two
 *     workers leapfrog each other for ever.
 *
 *   • **A cursor that skips forward loses changes permanently.** The Drive feed does not go
 *     back, so a rename or a deletion that fell in the gap is never seen again and nothing
 *     reports an error. This is why the guard is conditional rather than a plain write.
 *
 *   • **The first advance is the one most likely to be broken.** `from` is `null` there, and
 *     `start_page_token = NULL` is NULL in SQL, never true. An `=` comparison would make the
 *     very first cursor silently unwritable — and the symptom is a sync that reports success
 *     while re-initializing on every run.
 *
 *   • **`ensureState` must not disturb an existing row.** An upsert that reset `state` would
 *     clear the `failed` flag an operator is looking at, on every poll.
 *
 * Both engines run the same contract, because "Drive sync stopped working after cutover" is not
 * a failure anyone would attribute to the cursor repository.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestDb, stopTestDb, clearCollections } from '../helpers/test-db';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import { clearDataSourceOverrides } from '@/server/repositories/data-source';
import {
  d1DriveSyncRepository,
  mongoDriveSyncRepository,
} from '@/server/repositories/drive-sync.repository';
import type { DriveSyncRepository } from '@/server/repositories/drive-sync.repository.contract';

const ORG = '507f1f77bcf86cd799439011';
const OTHER_ORG = '507f1f77bcf86cd799439012';
const DRIVE = '0ABCdefGHIjklUk9PVA';
const OTHER_DRIVE = '0AXYZdefGHIjklUk9PVA';
const ISO = '2026-01-01T00:00:00.000Z';

let d1: D1Database;

async function seedD1(): Promise<void> {
  for (const id of [ORG, OTHER_ORG]) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO organizations
           (id, name, slug, email_domains, settings, storage_used_bytes, file_count, is_active,
            created_at, updated_at)
         VALUES (?, ?, ?, '[]', '{}', 0, 0, 1, ?, ?)`,
      )
      .bind(id, `Org ${id.slice(-2)}`, `org-${id.slice(-2)}`, ISO, ISO)
      .run();
  }
}

beforeAll(async () => {
  const mongo = await startTestDb();
  if (!mongo.available) {
    throw new Error(
      `This suite asserts that the MongoDB and D1 repositories agree, so it needs both. ` +
        `MongoDB could not start: ${mongo.reason}`,
    );
  }
  d1 = await startTestD1();
  setD1BindingForTesting(d1);
}, 300_000);

afterAll(async () => {
  setD1BindingForTesting(null);
  clearDataSourceOverrides();
  await stopTestD1();
  await stopTestDb();
});

interface Engine {
  name: 'mongo' | 'd1';
  repo: DriveSyncRepository;
  reset: () => Promise<void>;
}

const engines: Engine[] = [
  { name: 'mongo', repo: mongoDriveSyncRepository, reset: () => clearCollections() },
  {
    name: 'd1',
    repo: d1DriveSyncRepository,
    reset: async () => {
      await clearD1(d1, ['DELETE FROM drive_sync_states', 'DELETE FROM organizations']);
      await seedD1();
    },
  },
];

describe.each(engines)('the Drive sync cursor — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  it('creates the row on first use, idle and with no cursor', async () => {
    const state = await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });

    expect(state.organizationId).toBe(ORG);
    expect(state.sharedDriveId).toBe(DRIVE);
    expect(state.state).toBe('idle');
    // No cursor yet is the signal that makes the first poll take one and stop, rather than
    // trying to reconcile a corpus nobody asked us to distrust.
    expect(state.startPageToken).toBeNull();
    expect(state.consecutiveFailures).toBe(0);
  });

  it('returns the same row on a second call rather than creating a second one', async () => {
    const first = await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });
    const second = await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });

    expect(second.id).toBe(first.id);
    expect(await engine.repo.listStates()).toHaveLength(1);
  });

  it('does not disturb an existing row', async () => {
    const state = await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });
    await engine.repo.updateState(state.id, {
      state: 'failed',
      lastError: 'Drive returned 503',
      incrementFailures: 3,
    });

    /**
     * The critical assertion for `DO NOTHING` over `DO UPDATE`.
     *
     * `ensureState` runs at the top of every poll. If it reset the row, the `failed` state and
     * the failure count an operator is watching would be cleared every few minutes, and Drive
     * sync would look healthy while being broken.
     */
    const again = await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });
    expect(again.state).toBe('failed');
    expect(again.lastError).toBe('Drive returned 503');
    expect(again.consecutiveFailures).toBe(3);
  });

  it('survives two workers creating the row at the same moment', async () => {
    const results = await Promise.all([
      engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE }),
      engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE }),
    ]);

    // A unique-index violation here would turn a harmless race into a failed sync run.
    expect(results[0]!.id).toBe(results[1]!.id);
    expect(await engine.repo.listStates()).toHaveLength(1);
  });

  it('keeps one cursor per drive per organization', async () => {
    await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });
    await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: OTHER_DRIVE });
    await engine.repo.ensureState({ organizationId: OTHER_ORG, sharedDriveId: DRIVE });

    expect(await engine.repo.listStates()).toHaveLength(3);
    const found = await engine.repo.findState({
      organizationId: OTHER_ORG,
      sharedDriveId: DRIVE,
    });
    expect(found?.organizationId).toBe(OTHER_ORG);
  });

  it('takes the very first cursor, where `from` is null', async () => {
    const state = await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });

    /**
     * `start_page_token = NULL` is NULL in SQL, never true.
     *
     * An `=` comparison in the conditional advance would make this return false and the cursor
     * would never be written — so every poll would re-initialize, report success, and see
     * nothing. SQLite's `IS` is the null-safe form; this test is the reason it is used.
     */
    const advanced = await engine.repo.advanceCursor({
      id: state.id,
      from: null,
      to: 'token-1',
      appliedDelta: 0,
      conflictsDelta: 0,
    });

    expect(advanced).toBe(true);
    const after = await engine.repo.findState({ organizationId: ORG, sharedDriveId: DRIVE });
    expect(after?.startPageToken).toBe('token-1');
  });

  it('advances the cursor and accumulates the counters', async () => {
    const state = await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });
    await engine.repo.advanceCursor({
      id: state.id,
      from: null,
      to: 'token-1',
      appliedDelta: 4,
      conflictsDelta: 1,
    });
    await engine.repo.advanceCursor({
      id: state.id,
      from: 'token-1',
      to: 'token-2',
      appliedDelta: 3,
      conflictsDelta: 0,
    });

    const after = await engine.repo.findState({ organizationId: ORG, sharedDriveId: DRIVE });
    expect(after?.startPageToken).toBe('token-2');
    // Accumulated across pages, not overwritten per page: the total is what the monitoring view
    // reports, and a per-page value would read as "4 changes ever".
    expect(after?.changesApplied).toBe(7);
    expect(after?.conflictsDetected).toBe(1);
  });

  it('refuses to wind the cursor backwards from a stale read', async () => {
    const state = await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });
    await engine.repo.advanceCursor({
      id: state.id,
      from: null,
      to: 'token-1',
      appliedDelta: 1,
      conflictsDelta: 0,
    });

    // A second worker holding the pre-advance read. Letting this through would move the cursor
    // back to a page already applied and the two would leapfrog each other for ever.
    const stale = await engine.repo.advanceCursor({
      id: state.id,
      from: null,
      to: 'token-from-a-stale-worker',
      appliedDelta: 9,
      conflictsDelta: 9,
    });

    expect(stale).toBe(false);
    const after = await engine.repo.findState({ organizationId: ORG, sharedDriveId: DRIVE });
    expect(after?.startPageToken).toBe('token-1');
    // And the refused write applied none of its counters either.
    expect(after?.changesApplied).toBe(1);
    expect(after?.conflictsDetected).toBe(0);
  });

  it('lets exactly one of two concurrent advances win', async () => {
    const state = await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });
    await engine.repo.advanceCursor({
      id: state.id,
      from: null,
      to: 'token-1',
      appliedDelta: 0,
      conflictsDelta: 0,
    });

    const results = await Promise.all([
      engine.repo.advanceCursor({
        id: state.id,
        from: 'token-1',
        to: 'token-a',
        appliedDelta: 1,
        conflictsDelta: 0,
      }),
      engine.repo.advanceCursor({
        id: state.id,
        from: 'token-1',
        to: 'token-b',
        appliedDelta: 1,
        conflictsDelta: 0,
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await engine.repo.findState({ organizationId: ORG, sharedDriveId: DRIVE });
    expect(['token-a', 'token-b']).toContain(after?.startPageToken);
    expect(after?.changesApplied).toBe(1);
  });

  it('clears the expiry marker when the cursor advances again', async () => {
    const state = await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });
    await engine.repo.updateState(state.id, {
      state: 'reconciling',
      tokenExpiredAt: new Date('2026-05-01T00:00:00.000Z'),
    });

    await engine.repo.advanceCursor({
      id: state.id,
      from: null,
      to: 'token-1',
      appliedDelta: 0,
      conflictsDelta: 0,
    });

    // A stale `tokenExpiredAt` would keep forcing a full reconcile on a cursor that is fine.
    const after = await engine.repo.findState({ organizationId: ORG, sharedDriveId: DRIVE });
    expect(after?.tokenExpiredAt).toBeNull();
  });

  it('increments the failure counter rather than overwriting it', async () => {
    const state = await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });

    for (const attempt of [1, 2, 3]) {
      await engine.repo.updateState(state.id, {
        state: 'failed',
        lastError: `attempt ${attempt}`,
        incrementFailures: 1,
      });
    }

    const after = await engine.repo.findState({ organizationId: ORG, sharedDriveId: DRIVE });
    expect(after?.consecutiveFailures).toBe(3);
    expect(after?.lastError).toBe('attempt 3');
  });

  it('resets the failure counter on a successful poll', async () => {
    const state = await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });
    await engine.repo.updateState(state.id, { incrementFailures: 5 });
    await engine.repo.updateState(state.id, {
      state: 'idle',
      consecutiveFailures: 0,
      lastError: null,
      lastSuccessfulPollAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    const after = await engine.repo.findState({ organizationId: ORG, sharedDriveId: DRIVE });
    expect(after?.consecutiveFailures).toBe(0);
    expect(after?.lastError).toBeNull();
    expect(after?.state).toBe('idle');
  });

  it('records the reconcile timestamps a monitoring view reads', async () => {
    const state = await engine.repo.ensureState({ organizationId: ORG, sharedDriveId: DRIVE });
    const at = new Date('2026-06-01T12:00:00.000Z');

    await engine.repo.updateState(state.id, {
      state: 'idle',
      startPageToken: 'fresh-after-reconcile',
      tokenExpiredAt: null,
      lastFullReconcileAt: at,
      lastSuccessfulPollAt: at,
    });

    const after = await engine.repo.findState({ organizationId: ORG, sharedDriveId: DRIVE });
    expect(after?.lastFullReconcileAt?.toISOString()).toBe(at.toISOString());
    expect(after?.startPageToken).toBe('fresh-after-reconcile');
  });

  it('returns null for a drive that has never been synchronized', async () => {
    expect(
      await engine.repo.findState({ organizationId: ORG, sharedDriveId: 'never-seen' }),
    ).toBeNull();
  });
});
