/**
 * The one way a service sends notifications.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────
 *
 * Review requests, decisions and comment mentions were written with a detached
 * `void notificationRepository.createMany(…)`, to keep the request fast. In a Worker a detached
 * promise may be cancelled when the response is returned, so those notifications would
 * sometimes silently never exist. The Worker path therefore hands them to `NOTIFICATION_QUEUE`,
 * which is durable and retried; Node keeps writing inline, as it always has.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────────────────
 *
 * Every notification gets a `dedupeKey` of `<eventKey>:<type>:<recipient>`, fixed *before* the
 * message is sent. A redelivered message carries the same keys and both engines turn the repeat
 * into a no-op (`notification.repository.contract.ts`). The event key identifies one occurrence
 * — `review-requested:<reviewId>`, `comment:<commentId>` — so two genuinely separate events
 * still produce two notifications, which is the property the contract says must survive.
 */
import * as notificationRepository from '@/server/repositories/notification.repository';
import type { CreateNotificationInput } from '@/server/repositories/notification.repository';
import { getLogger } from '@/server/logging/logger';
import { getQueueProducer } from './bindings';
import {
  MAX_NOTIFICATIONS_PER_MESSAGE,
  type NotificationMessage,
  type QueuedNotification,
} from './messages';

export type NotificationDraft = Omit<CreateNotificationInput, 'dedupeKey'>;

/** A fresh event key for an event with no natural identifier of its own. */
export function newEventKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function withDedupeKeys(
  drafts: NotificationDraft[],
  eventKey: string,
): QueuedNotification[] {
  return drafts.map((draft) => ({
    ...draft,
    dedupeKey: `${eventKey}:${draft.type}:${draft.userId}`.slice(0, 300),
  })) as QueuedNotification[];
}

export async function dispatchNotifications(
  drafts: NotificationDraft[],
  eventKey: string,
): Promise<void> {
  if (drafts.length === 0) return;
  const notifications = withDedupeKeys(drafts, eventKey);

  const queue = getQueueProducer<NotificationMessage>('NOTIFICATION_QUEUE');
  if (!queue) {
    await notificationRepository.createMany(notifications);
    return;
  }

  for (let start = 0; start < notifications.length; start += MAX_NOTIFICATIONS_PER_MESSAGE) {
    await queue.send({
      kind: 'notifications.create',
      version: 1,
      notifications: notifications.slice(start, start + MAX_NOTIFICATIONS_PER_MESSAGE),
    });
  }
  getLogger().debug({ eventKey, count: notifications.length }, 'Notifications queued');
}
