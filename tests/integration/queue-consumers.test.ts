/**
 * Queue producers and consumers: Drive sync and notifications.
 *
 * The properties asserted are the ones at-least-once delivery makes necessary:
 *
 *   • a redelivered message changes nothing;
 *   • a message cannot make the application do more than its producer could have done inline —
 *     the organization is resolved server-side, and a recipient who is inactive or belongs to a
 *     different organization is not notified;
 *   • a failure that may heal is retried with backoff, and one that never can is dropped loudly;
 *   • the internal delivery route exists only for the holder of the in-process token.
 *
 * Real MongoDB. The Worker entrypoint's batch handling is exercised by the Worker preview; what
 * it calls into is exercised here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { seedFixture, type Fixture } from '../helpers/fixtures';
import { NotificationModel, UserModel } from '@/server/db/models';
import type { QueueProducer } from '@/server/queues/bindings';

let db: TestDb;
let fixture: Fixture;

beforeAll(async () => {
  db = await startTestDb();
  if (!db.available) throw new Error(`MongoDB is required: ${db.reason}`);
  fixture = await seedFixture();
}, 180_000);

afterAll(async () => {
  if (db?.available) await stopTestDb();
});

afterEach(async () => {
  vi.restoreAllMocks();
  const { setQueueBindingsForTesting } = await import('@/server/queues/bindings');
  setQueueBindingsForTesting(null);
  await NotificationModel.deleteMany({});
});

function draft(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: fixture.organizationId,
    userId,
    type: 'review.requested' as const,
    actorUserId: fixture.users.scientistA,
    actorName: 'Alice',
    entityType: 'file',
    entityId: '0123456789abcdef01234567',
    entityLabel: 'run-42.pdf',
    message: 'Alice asked you to review "run-42.pdf"',
    ...overrides,
  };
}

describe('notification dispatch', () => {
  it('writes inline on Node, and a repeat of the same event is a no-op', async () => {
    const { dispatchNotifications } = await import('@/server/queues/notification-dispatch');
    await dispatchNotifications([draft(fixture.users.scientistB)], 'review-requested:r1');
    await dispatchNotifications([draft(fixture.users.scientistB)], 'review-requested:r1');
    expect(await NotificationModel.countDocuments({ userId: fixture.users.scientistB })).toBe(1);
  });

  it('keeps two genuinely separate events as two notifications', async () => {
    const { dispatchNotifications, newEventKey } = await import('@/server/queues/notification-dispatch');
    await dispatchNotifications([draft(fixture.users.scientistB)], newEventKey('share'));
    await dispatchNotifications([draft(fixture.users.scientistB)], newEventKey('share'));
    expect(await NotificationModel.countDocuments({ userId: fixture.users.scientistB })).toBe(2);
  });

  it('in a Worker, sends valid messages to the queue instead of writing — split to fit the size cap', async () => {
    const { setQueueBindingsForTesting } = await import('@/server/queues/bindings');
    const { dispatchNotifications } = await import('@/server/queues/notification-dispatch');
    const { notificationMessageSchema } = await import('@/server/queues/messages');
    const sent: unknown[] = [];
    const producer: QueueProducer = { send: async (body) => void sent.push(body) };
    setQueueBindingsForTesting({ NOTIFICATION_QUEUE: producer });

    const drafts = Array.from({ length: 60 }, () => draft(fixture.users.scientistB));
    await dispatchNotifications(drafts, 'review-requested:r2');

    expect(sent).toHaveLength(2);
    for (const message of sent) expect(notificationMessageSchema.safeParse(message).success).toBe(true);
    expect(await NotificationModel.countDocuments({})).toBe(0);
  });
});

describe('notification consumer', () => {
  async function message(notifications: ReturnType<typeof draft>[], eventKey = 'review-requested:r3') {
    const { withDedupeKeys } = await import('@/server/queues/notification-dispatch');
    return { kind: 'notifications.create', version: 1, notifications: withDedupeKeys(notifications, eventKey) };
  }

  it('writes once however many times the message is delivered', async () => {
    const { consumeNotifications } = await import('@/server/queues/consumers');
    const body = await message([draft(fixture.users.scientistB), draft(fixture.users.viewer)]);

    expect((await consumeNotifications(body)).outcome).toBe('ack');
    expect((await consumeNotifications(body)).outcome).toBe('ack');
    expect((await consumeNotifications(body)).outcome).toBe('ack');
    expect(await NotificationModel.countDocuments({})).toBe(2);
  });

  it('does not notify a deactivated recipient, or one claimed to be in another organization', async () => {
    const { consumeNotifications } = await import('@/server/queues/consumers');
    await UserModel.updateOne({ _id: fixture.users.viewer }, { $set: { status: 'deactivated' } });
    try {
      const body = await message([
        draft(fixture.users.scientistB),
        draft(fixture.users.viewer),
        draft(fixture.users.noRole, { organizationId: 'ffffffffffffffffffffffff' }),
      ]);
      const result = await consumeNotifications(body);
      expect(result).toMatchObject({ outcome: 'ack', detail: { received: 3, written: 1 } });
      expect(await NotificationModel.countDocuments({})).toBe(1);
    } finally {
      await UserModel.updateOne({ _id: fixture.users.viewer }, { $set: { status: 'active' } });
    }
  });

  it('drops a malformed message instead of retrying it forever', async () => {
    const { consumeNotifications } = await import('@/server/queues/consumers');
    expect((await consumeNotifications({ kind: 'notifications.create', version: 1, notifications: [] })).outcome).toBe('drop');
    expect((await consumeNotifications({ kind: 'notifications.create', version: 2 })).outcome).toBe('drop');
    // A notification without its dedupe key could be duplicated by a retry, so it is refused.
    const unkeyed: Record<string, unknown> = { ...(await message([draft(fixture.users.scientistB)])).notifications[0]! };
    delete unkeyed.dedupeKey;
    expect(
      (await consumeNotifications({ kind: 'notifications.create', version: 1, notifications: [unkeyed] })).outcome,
    ).toBe('drop');
  });

  it('retries, with backoff, when the database refuses', async () => {
    const repository = await import('@/server/repositories/notification.repository');
    const { processQueueMessage } = await import('@/server/queues/consumers');
    vi.spyOn(repository, 'createMany').mockRejectedValueOnce(new Error('connection reset'));

    const result = await processQueueMessage({
      queue: 'notifications',
      messageId: 'm1',
      attempts: 3,
      body: await message([draft(fixture.users.scientistB)]),
    });
    expect(result).toEqual({ outcome: 'retry', reason: 'connection reset', delaySeconds: 120 });
  });
});

describe('Drive sync consumer', () => {
  const syncMessage = { kind: 'drive.sync', trigger: 'cron', requestedAt: new Date().toISOString() };

  it('resolves the organization itself and runs one bounded sync', async () => {
    const { driveSyncService } = await import('@/server/services/drive-sync.service');
    const { consumeDriveSync } = await import('@/server/queues/consumers');
    const spy = vi.spyOn(driveSyncService, 'syncDriveChanges').mockResolvedValue({
      ran: true, initialized: false, pages: 1, changes: 3, unmanaged: 0, contentUpdated: 1, renamed: 1,
      trashed: 0, restored: 0, missing: 0, conflicts: 1, approvalsReturnedToReview: 0,
      reconciled: false, reconcileChecked: 0, error: null,
    });

    const result = await consumeDriveSync(syncMessage);
    expect(result).toMatchObject({ outcome: 'ack', detail: { changes: 3, conflicts: 1 } });
    expect(spy).toHaveBeenCalledWith({ organizationId: fixture.organizationId, maxPages: 10, pageSize: 100 });
  });

  it('refuses a message that tries to name its own organization', async () => {
    const { consumeDriveSync } = await import('@/server/queues/consumers');
    const result = await consumeDriveSync({ ...syncMessage, organizationId: 'ffffffffffffffffffffffff' });
    expect(result.outcome).toBe('drop');
  });

  it('acknowledges without work when Drive storage is off, and retries a failed run', async () => {
    const { driveSyncService } = await import('@/server/services/drive-sync.service');
    const { consumeDriveSync } = await import('@/server/queues/consumers');
    const base = {
      initialized: false, pages: 0, changes: 0, unmanaged: 0, contentUpdated: 0, renamed: 0, trashed: 0,
      restored: 0, missing: 0, conflicts: 0, approvalsReturnedToReview: 0, reconciled: false, reconcileChecked: 0,
    };

    vi.spyOn(driveSyncService, 'syncDriveChanges').mockResolvedValueOnce({ ...base, ran: false, error: null });
    expect((await consumeDriveSync(syncMessage)).outcome).toBe('ack');

    vi.spyOn(driveSyncService, 'syncDriveChanges').mockResolvedValueOnce({ ...base, ran: true, error: 'Drive 503' });
    expect(await consumeDriveSync(syncMessage)).toMatchObject({ outcome: 'retry', reason: 'Drive 503' });
  });
});

describe('internal delivery route', () => {
  async function post(headers: Record<string, string>, body: unknown): Promise<Response> {
    const { POST } = await import('@/app/api/internal/queues/route');
    return POST(
      new NextRequest('http://localhost:3000/api/internal/queues', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      undefined,
    );
  }

  const delivery = {
    queue: 'notifications',
    messageId: 'm2',
    attempts: 1,
    body: { kind: 'notifications.create', version: 1, notifications: [] },
  };

  it('is 404 without the in-process token, and 404 with a guessed one', async () => {
    expect((await post({}, delivery)).status).toBe(404);
    const { ensureInternalQueueToken } = await import('@/server/queues/internal-token');
    ensureInternalQueueToken();
    expect((await post({ 'x-internal-queue-token': 'guess' }, delivery)).status).toBe(404);
  });

  it('delivers to the consumer for the holder of the token', async () => {
    const { ensureInternalQueueToken } = await import('@/server/queues/internal-token');
    const response = await post({ 'x-internal-queue-token': ensureInternalQueueToken() }, delivery);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { outcome: string } }).data.outcome).toBe('drop');
  });
});
