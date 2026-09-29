/**
 * Phase 6 — notifications on D1, and idempotency under Queue retry.
 *
 * The interesting assertions here are not "a notification can be written and read back". They
 * are the two properties that only matter once delivery moves onto a queue:
 *
 *   1. **A redelivery must not produce a second row.** Cloudflare Queues deliver at least once,
 *      so a consumer interrupted between the write and the acknowledgement will see the same
 *      message again. Proved by writing the same `dedupeKey` twice and counting.
 *
 *   2. **Deduplication must not over-reach.** Two genuinely separate events — the same person
 *      sharing the same file with you twice — carry no key and must both appear. An
 *      implementation that deduplicated on content rather than on an explicit key would pass
 *      test 1 and silently swallow real notifications.
 *
 * Plus the authorization property the contract turns on: every read and `markRead` is scoped to
 * the recipient, so a guessed notification id reaches nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestDb, stopTestDb, clearCollections } from '../helpers/test-db';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import {
  d1NotificationRepository,
  mongoNotificationRepository,
} from '@/server/repositories/notification.repository';
import type {
  CreateNotificationInput,
  NotificationRepository,
} from '@/server/repositories/notification.repository.contract';
import { clearDataSourceOverrides } from '@/server/repositories/data-source';

const ORG = '507f1f77bcf86cd799439011';
const ALICE = '507f1f77bcf86cd7994390a1';
const BOB = '507f1f77bcf86cd7994390a2';
const FILE = '507f1f77bcf86cd7994390f1';

const ISO = '2026-01-01T00:00:00.000Z';

let d1: D1Database;

interface Engine {
  name: 'mongo' | 'd1';
  repository: NotificationRepository;
  reset: () => Promise<void>;
}

function notification(overrides: Partial<CreateNotificationInput> = {}): CreateNotificationInput {
  return {
    organizationId: ORG,
    userId: ALICE,
    type: 'share.received',
    actorUserId: BOB,
    actorName: 'Bob',
    entityType: 'file',
    entityId: FILE,
    entityLabel: 'Tox-Study-Protocol.pdf',
    message: 'Bob shared Tox-Study-Protocol.pdf with you',
    ...overrides,
  };
}

async function seedD1Identity(): Promise<void> {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO organizations
         (id, name, slug, email_domains, settings, storage_used_bytes, file_count, is_active, created_at, updated_at)
       VALUES (?, 'Org', 'org', '[]', '{}', 0, 0, 1, ?, ?)`,
    )
    .bind(ORG, ISO, ISO)
    .run();

  for (const [id, name] of [
    [ALICE, 'Alice'],
    [BOB, 'Bob'],
  ]) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO users
           (id, organization_id, email, email_domain, name, status, storage_quota_bytes, storage_used_bytes, created_at, updated_at)
         VALUES (?, ?, ?, 'example.com', ?, 'active', 1000000, 0, ?, ?)`,
      )
      .bind(id, ORG, `${name!.toLowerCase()}@example.com`, name, ISO, ISO)
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

const engines: Engine[] = [
  {
    name: 'mongo',
    repository: mongoNotificationRepository,
    reset: async () => {
      await clearCollections();
    },
  },
  {
    name: 'd1',
    repository: d1NotificationRepository,
    reset: async () => {
      await clearD1(d1, ['DELETE FROM notifications', 'DELETE FROM users', 'DELETE FROM organizations']);
      await seedD1Identity();
    },
  },
];

describe.each(engines)('notification repository — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  it('writes and reads back a notification', async () => {
    await engine.repository.create(notification());

    const listed = await engine.repository.listForUser(ALICE);

    expect(listed).toHaveLength(1);
    expect(listed[0]!.message).toBe('Bob shared Tox-Study-Protocol.pdf with you');
    expect(listed[0]!.entityLabel).toBe('Tox-Study-Protocol.pdf');
    expect(listed[0]!.readAt).toBeNull();
    expect(listed[0]!.createdAt).toBeInstanceOf(Date);
  });

  it('never returns another person’s notifications', async () => {
    await engine.repository.create(notification({ userId: ALICE }));
    await engine.repository.create(notification({ userId: BOB, dedupeKey: null }));

    expect(await engine.repository.listForUser(ALICE)).toHaveLength(1);
    expect(await engine.repository.countUnread(BOB)).toBe(1);
  });

  /** Property 1: the reason `dedupeKey` exists. */
  it('turns a redelivery of the same event into a no-op', async () => {
    const input = notification({ dedupeKey: 'review-requested:rev-1:alice' });

    await engine.repository.create(input);
    await engine.repository.create(input);
    await engine.repository.create(input);

    expect(await engine.repository.listForUser(ALICE)).toHaveLength(1);
  });

  /**
   * Property 2: deduplication is keyed on the event, not on the content.
   *
   * Without this, an implementation that collapsed identical messages would look correct.
   */
  it('keeps two identical notifications that carry no dedupe key', async () => {
    await engine.repository.create(notification());
    await engine.repository.create(notification());

    expect(await engine.repository.listForUser(ALICE)).toHaveLength(2);
  });

  it('deduplicates a fan-out written in one call', async () => {
    const inputs = [
      notification({ userId: ALICE, dedupeKey: 'review:r1:alice' }),
      notification({ userId: BOB, dedupeKey: 'review:r1:bob' }),
    ];

    await engine.repository.createMany(inputs);
    await engine.repository.createMany(inputs);

    expect(await engine.repository.listForUser(ALICE)).toHaveLength(1);
    expect(await engine.repository.listForUser(BOB)).toHaveLength(1);
  });

  it('counts and filters unread', async () => {
    await engine.repository.create(notification());
    await engine.repository.create(notification());

    expect(await engine.repository.countUnread(ALICE)).toBe(2);

    const [first] = await engine.repository.listForUser(ALICE);
    expect(await engine.repository.markRead(ALICE, first!.id)).toBe(true);

    expect(await engine.repository.countUnread(ALICE)).toBe(1);
    expect(await engine.repository.listForUser(ALICE, { unreadOnly: true })).toHaveLength(1);
  });

  /** A guessed id belonging to somebody else must change nothing. */
  it('refuses to mark another person’s notification read', async () => {
    await engine.repository.create(notification({ userId: BOB }));
    const [bobs] = await engine.repository.listForUser(BOB);

    expect(await engine.repository.markRead(ALICE, bobs!.id)).toBe(false);
    expect(await engine.repository.countUnread(BOB)).toBe(1);
  });

  it('marks every unread notification read, and reports how many changed', async () => {
    await engine.repository.create(notification());
    await engine.repository.create(notification());
    await engine.repository.create(notification({ userId: BOB }));

    expect(await engine.repository.markAllRead(ALICE)).toBe(2);
    expect(await engine.repository.countUnread(ALICE)).toBe(0);
    // Not everyone's — the scope is the recipient.
    expect(await engine.repository.countUnread(BOB)).toBe(1);
  });

  it('purges notifications pointing at an entity that no longer exists', async () => {
    await engine.repository.create(notification({ entityId: FILE }));
    await engine.repository.create(notification({ entityId: '507f1f77bcf86cd7994390f2' }));

    expect(await engine.repository.purgeForEntities([FILE])).toBe(1);
    expect(await engine.repository.listForUser(ALICE)).toHaveLength(1);
  });

  it('caps the page at the shared maximum', async () => {
    for (let i = 0; i < 5; i += 1) {
      await engine.repository.create(notification({ message: `message ${i}` }));
    }

    expect(await engine.repository.listForUser(ALICE, { limit: 3 })).toHaveLength(3);
  });
});
