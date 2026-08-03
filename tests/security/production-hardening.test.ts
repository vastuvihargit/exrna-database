/**
 * Production hardening — the abuse cases Phase 11 asks for explicit proof of.
 *
 * Everything here is about a client that is not behaving: hammering the upload
 * authorization endpoint, pushing past a storage quota, scripting search. The common
 * thread is that each of them must be refused *before* it consumes anything, and must
 * leave no half-made record behind — a rejected upload that still creates a session row
 * has reserved quota for a file that will never exist.
 *
 * The alerting tests cover the opposite failure: a monitor that is technically working
 * but has made itself useless by repeating. An alert channel people have muted is worse
 * than no alert channel, because it looks like coverage.
 *
 * Runs against a real in-memory MongoDB, because cooldown state and quota accounting
 * both live in the database and a mock would be asserting my own assumptions back at me.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { actorFor, seedFixture, TEST_META, type Fixture } from '../helpers/fixtures';
import { RATE_LIMITS, resetAllRateLimits } from '@/server/auth/rate-limit';
import type { Actor } from '@/server/permissions/actor';
import type { SystemCheck } from '@/server/services/system-checks';

let db: TestDb;
let fixture: Fixture;

function skipUnlessDb(): boolean {
  if (db.available) return false;
  expect(db.reason, 'in-memory MongoDB unavailable').toBeTruthy();
  return true;
}

beforeAll(async () => {
  db = await startTestDb();
  if (!db.available) return;
  fixture = await seedFixture();
  const { getStorageProvider } = await import('@/server/storage');
  await getStorageProvider().ensureReady();
}, 180_000);

afterAll(async () => {
  if (db?.available) await stopTestDb();
});

beforeEach(() => {
  // Counters are process-global; without this, the order tests run in would decide
  // whether they pass.
  resetAllRateLimits();
});

async function services() {
  return {
    uploadService: (await import('@/server/services/upload.service')).uploadService,
    searchService: (await import('@/server/services/search.service')).searchService,
    folderService: (await import('@/server/services/folder.service')).folderService,
    driveService: (await import('@/server/services/drive.service')).driveService,
    sessionRepository: await import('@/server/repositories/upload-session.repository'),
  };
}

async function personalFolder(actor: Actor, name: string): Promise<string> {
  const { driveService, folderService } = await services();
  const root = await driveService.getMyDriveRoot(actor);
  const folder = await folderService.createFolder(
    actor,
    { name, parentFolderId: root.id },
    TEST_META,
  );
  return folder.id;
}

/* ─────────────────────────────── upload abuse ───────────────────────────── */

describe('upload abuse', () => {
  it('refuses to keep opening upload sessions past the rate limit', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, sessionRepository } = await services();
    const actor = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(actor, 'Rate limited uploads');

    const limit = RATE_LIMITS.uploadAuthorize.limit;
    let accepted = 0;
    let rejection: unknown = null;

    // One past the limit. The point is not the exact number — it is that there IS one.
    for (let attempt = 0; attempt < limit + 1; attempt += 1) {
      try {
        await uploadService.authorizeUpload(
          actor,
          { folderId, filename: `sample-${attempt}.csv`, size: 32 },
          TEST_META,
        );
        accepted += 1;
      } catch (error) {
        rejection = error;
        break;
      }
    }

    expect(accepted).toBe(limit);
    expect((rejection as { code?: string })?.code).toBe('RATE_LIMITED');
    expect((rejection as { status?: number })?.status).toBe(429);

    // And the refusal reserved nothing: exactly the accepted sessions exist, not one more.
    const counts = await sessionRepository.countByStatus();
    const opened = Object.values(counts).reduce((total, value) => total + value, 0);
    expect(opened).toBe(limit);
  }, 120_000);

  it('carries a Retry-After so a well-behaved client can back off', async () => {
    if (skipUnlessDb()) return;
    const { uploadService } = await services();
    const actor = await actorFor(fixture.users.scientistB);
    const folderId = await personalFolder(actor, 'Retry-after uploads');

    const limit = RATE_LIMITS.uploadAuthorize.limit;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await uploadService.authorizeUpload(
        actor,
        { folderId, filename: `s-${attempt}.csv`, size: 16 },
        TEST_META,
      );
    }

    await expect(
      uploadService.authorizeUpload(actor, { folderId, filename: 'one-too-many.csv', size: 16 }, TEST_META),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: expect.any(Number) });
  }, 120_000);

  it('limits one user without limiting their colleagues', async () => {
    if (skipUnlessDb()) return;
    // The counter is keyed per actor. A shared counter would let one person's bulk
    // import lock the whole department out of uploading.
    const { uploadService } = await services();
    const noisy = await actorFor(fixture.users.scientistA);
    const quiet = await actorFor(fixture.users.scientistB);
    const noisyFolder = await personalFolder(noisy, 'Noisy neighbour');
    const quietFolder = await personalFolder(quiet, 'Quiet neighbour');

    for (let attempt = 0; attempt < RATE_LIMITS.uploadAuthorize.limit; attempt += 1) {
      await uploadService.authorizeUpload(
        noisy,
        { folderId: noisyFolder, filename: `n-${attempt}.csv`, size: 16 },
        TEST_META,
      );
    }

    await expect(
      uploadService.authorizeUpload(noisy, { folderId: noisyFolder, filename: 'blocked.csv', size: 16 }, TEST_META),
    ).rejects.toMatchObject({ status: 429 });

    // The colleague is unaffected.
    await expect(
      uploadService.authorizeUpload(quiet, { folderId: quietFolder, filename: 'fine.csv', size: 16 }, TEST_META),
    ).resolves.toMatchObject({ sessionId: expect.any(String), status: 'pending' });
  }, 180_000);
});

/* ─────────────────────────────── storage limits ─────────────────────────── */

describe('storage limits', () => {
  it('refuses an upload that would exceed the personal quota, before any bytes arrive', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, sessionRepository } = await services();
    const { UserModel } = await import('@/server/db/models');

    const actor = await actorFor(fixture.users.viewer);
    const folderId = await personalFolder(actor, 'Quota test');

    await UserModel.updateOne({ _id: fixture.users.viewer }, { $set: { storageQuotaBytes: 1024 } });

    const before = await sessionRepository.countByStatus();

    await expect(
      uploadService.authorizeUpload(
        actor,
        { folderId, filename: 'too-big.csv', size: 10 * 1024 * 1024 },
        TEST_META,
      ),
      // 507 Insufficient Storage, not 413: the request is not too large in itself, there
      // is nowhere to put it. The distinction matters to a client deciding whether to
      // retry with a smaller file or not at all.
    ).rejects.toMatchObject({ status: 507 });

    // No session, no reservation. A refused upload must cost nothing.
    const after = await sessionRepository.countByStatus();
    expect(sum(after)).toBe(sum(before));

    await UserModel.updateOne(
      { _id: fixture.users.viewer },
      { $set: { storageQuotaBytes: 20 * 1024 ** 3 } },
    );
  }, 60_000);

  it('refuses every upload when the volume is below its free-space floor', async () => {
    if (skipUnlessDb()) return;
    // The floor exists because a genuinely full disk corrupts writes rather than
    // failing them. The system must stop before it gets there, not at 100%.
    const { resetEnvCache } = await import('@/server/config/env');
    const { uploadService } = await services();
    const actor = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(actor, 'Disk floor');

    const original = process.env.MIN_FREE_DISK_GB;
    process.env.MIN_FREE_DISK_GB = '999999';
    resetEnvCache();

    try {
      await expect(
        uploadService.authorizeUpload(actor, { folderId, filename: 'blocked.csv', size: 32 }, TEST_META),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      if (original === undefined) delete process.env.MIN_FREE_DISK_GB;
      else process.env.MIN_FREE_DISK_GB = original;
      resetEnvCache();
    }
  }, 60_000);

  it('rate-limits search, which is the most expensive read in the system', async () => {
    if (skipUnlessDb()) return;
    const { searchService } = await services();
    const actor = await actorFor(fixture.users.scientistA);

    for (let attempt = 0; attempt < RATE_LIMITS.search.limit; attempt += 1) {
      await searchService.search(actor, { q: 'protocol', page: 1, pageSize: 10 } as never);
    }

    await expect(
      searchService.search(actor, { q: 'protocol', page: 1, pageSize: 10 } as never),
    ).rejects.toMatchObject({ status: 429 });
  }, 120_000);
});

/* ──────────────────────────────── alerting ──────────────────────────────── */

describe('alerting', () => {
  const check = (severity: SystemCheck['severity'], detail = 'detail'): SystemCheck[] => [
    { key: 'disk', label: 'Storage volume', severity, detail },
  ];

  beforeEach(async () => {
    if (!db?.available) return;
    const { resetAlertState } = await import('@/server/monitoring/alerts');
    await resetAlertState();
  });

  it('sends a new condition once and then goes quiet', async () => {
    if (skipUnlessDb()) return;
    const { dispatchAlerts } = await import('@/server/monitoring/alerts');

    const first = await dispatchAlerts(check('warning'), { dryRun: true });
    expect(first[0]).toMatchObject({ key: 'disk', action: 'sent' });

    // The disk being 92% full is one piece of news, not one every fifteen minutes.
    const second = await dispatchAlerts(check('warning'), { dryRun: true });
    expect(second[0]).toMatchObject({ action: 'suppressed' });
  }, 60_000);

  it('breaks the cooldown when a warning becomes critical', async () => {
    if (skipUnlessDb()) return;
    const { dispatchAlerts } = await import('@/server/monitoring/alerts');

    await dispatchAlerts(check('warning'), { dryRun: true });
    const escalation = await dispatchAlerts(check('critical'), { dryRun: true });

    // Genuinely new information, so silence would be wrong however recently we spoke.
    expect(escalation[0]).toMatchObject({ action: 'escalated', severity: 'critical' });
  }, 60_000);

  it('re-alerts once the cooldown has passed', async () => {
    if (skipUnlessDb()) return;
    const { dispatchAlerts } = await import('@/server/monitoring/alerts');

    const start = new Date('2026-07-30T00:00:00Z');
    await dispatchAlerts(check('critical'), { now: start, dryRun: true });

    const withinCooldown = await dispatchAlerts(check('critical'), {
      now: new Date(start.getTime() + 30 * 60_000),
      dryRun: true,
    });
    expect(withinCooldown[0]).toMatchObject({ action: 'suppressed' });

    const afterCooldown = await dispatchAlerts(check('critical'), {
      now: new Date(start.getTime() + 90 * 60_000),
      dryRun: true,
    });
    expect(afterCooldown[0]).toMatchObject({ action: 'sent' });
  }, 60_000);

  it('reports recovery exactly once', async () => {
    if (skipUnlessDb()) return;
    // Silence is ambiguous: it means either "fixed" or "the monitor died". Saying so
    // removes the ambiguity — but saying it every fifteen minutes is noise.
    const { dispatchAlerts } = await import('@/server/monitoring/alerts');

    await dispatchAlerts(check('critical'), { dryRun: true });
    const recovery = await dispatchAlerts(check('ok', 'Free space is comfortable.'), { dryRun: true });
    expect(recovery[0]).toMatchObject({ action: 'recovered' });

    const stillHealthy = await dispatchAlerts(check('ok'), { dryRun: true });
    expect(stillHealthy).toHaveLength(0);
  }, 60_000);

  it('says nothing at all about a condition that was never a problem', async () => {
    if (skipUnlessDb()) return;
    const { dispatchAlerts } = await import('@/server/monitoring/alerts');
    expect(await dispatchAlerts(check('ok'), { dryRun: true })).toHaveLength(0);
  }, 60_000);

  it('tracks conditions independently', async () => {
    if (skipUnlessDb()) return;
    const { dispatchAlerts } = await import('@/server/monitoring/alerts');

    const outcomes = await dispatchAlerts(
      [
        { key: 'disk', label: 'Storage volume', severity: 'warning', detail: 'a' },
        { key: 'backup', label: 'Backups', severity: 'critical', detail: 'b' },
      ],
      { dryRun: true },
    );

    expect(outcomes.map((outcome) => outcome.action)).toEqual(['sent', 'sent']);

    // Only the backup escalates; the disk must stay suppressed on its own schedule.
    const second = await dispatchAlerts(
      [
        { key: 'disk', label: 'Storage volume', severity: 'warning', detail: 'a' },
        { key: 'backup', label: 'Backups', severity: 'critical', detail: 'b' },
      ],
      { dryRun: true },
    );
    expect(second.map((outcome) => outcome.action)).toEqual(['suppressed', 'suppressed']);
  }, 60_000);
});

/* ──────────────────────────── index declarations ────────────────────────── */

describe('MongoDB indexes', () => {
  it('has built every index the schemas declare', async () => {
    if (skipUnlessDb()) return;
    // The Phase 11 index review, as an assertion. A declared index that was never built
    // turns a fast query into a collection scan, and the symptom ("it got slow") is a
    // long way from the cause ("syncIndexes never ran on deploy").
    const { registeredModels } = await import('@/server/db/models');

    const missing: string[] = [];

    for (const model of registeredModels) {
      const declared = model.schema.indexes().map(([key]) => signature(key as KeyLike));
      const live = new Set(
        (
          (await model.collection.indexes()) as Array<{ key: KeyLike; weights?: Record<string, number> }>
        ).map((index) => signature(index.key, index.weights)),
      );

      for (const entry of declared) {
        if (!live.has(entry)) missing.push(`${model.collection.collectionName}: {${entry}}`);
      }
    }

    expect(missing, `Declared but not built: ${missing.join(', ')}`).toEqual([]);
  }, 120_000);

  it('declares no index whose key is a redundant prefix of another', async () => {
    if (skipUnlessDb()) return;
    // {a:1} earns nothing when {a:1,b:1} exists — MongoDB uses the compound index for
    // both — but it is paid for on every single write.
    const { registeredModels } = await import('@/server/db/models');
    const redundant: string[] = [];

    for (const model of registeredModels) {
      const indexes = (await model.collection.indexes()) as Array<{
        name: string;
        key: KeyLike;
        unique?: boolean;
        partialFilterExpression?: unknown;
      }>;

      for (const candidate of indexes) {
        // Uniqueness and partial filters change what an index *means*, not just how
        // fast it is, so an overlapping key is not redundancy there.
        if (candidate.name === '_id_' || candidate.unique || candidate.partialFilterExpression) {
          continue;
        }
        const candidateFields = Object.keys(candidate.key);

        for (const other of indexes) {
          if (other.name === candidate.name || other.partialFilterExpression) continue;
          const otherFields = Object.keys(other.key);
          if (otherFields.length <= candidateFields.length) continue;

          const isPrefix = candidateFields.every(
            (field, position) =>
              otherFields[position] === field && other.key[field] === candidate.key[field],
          );
          if (isPrefix) {
            redundant.push(
              `${model.collection.collectionName}: ${candidate.name} is a prefix of ${other.name}`,
            );
            break;
          }
        }
      }
    }

    expect(redundant, `Redundant indexes: ${redundant.join(', ')}`).toEqual([]);
  }, 120_000);
});

type KeyLike = Record<string, number | string>;

/**
 * A comparable form of an index key.
 *
 * Text indexes need special handling: a schema declares `{name: 'text', email: 'text'}`
 * but MongoDB reports the built index as `{_fts: 'text', _ftsx: 1}` with the real fields
 * moved into `weights`. Comparing the raw keys would report every text index in the
 * system as "declared but never built" — which is exactly the false alarm that teaches
 * people to ignore the check.
 */
function signature(key: KeyLike, weights?: Record<string, number>): string {
  const textFields = weights
    ? Object.keys(weights)
    : Object.entries(key)
        .filter(([, direction]) => direction === 'text')
        .map(([field]) => field);

  if (textFields.length > 0) {
    const rest = Object.entries(key)
      .filter(([field, direction]) => direction !== 'text' && field !== '_fts' && field !== '_ftsx')
      .map(([field, direction]) => `${field}:${direction}`);
    return [`text(${[...textFields].sort().join(',')})`, ...rest].join(',');
  }

  return Object.entries(key)
    .map(([field, direction]) => `${field}:${direction}`)
    .join(',');
}

function sum(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}
