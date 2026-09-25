/**
 * Queue consumers. Pure application logic: no Worker types, no bindings.
 *
 * The Worker entrypoint (`cloudflare/worker.ts`) receives a batch and hands each message here
 * through the internal route, so this code runs inside the same Next.js bundle, with the same
 * repositories, flags and logger, as every request. Each function returns what should happen
 * to the message; acknowledging, retrying and dead-lettering are the entrypoint's job.
 *
 * ── Properties both consumers keep ──────────────────────────────────────────────────────
 *
 *   • **Idempotent.** Delivery is at-least-once. A redelivered Drive-sync message is another
 *     bounded run against a cursor that only advances after a page is applied; a redelivered
 *     notification message carries the same dedupe keys and changes nothing.
 *   • **Nothing is trusted from the payload** beyond "please do this". See `messages.ts`.
 *   • **Every outcome is logged** with the queue, the message id and the attempt number, so a
 *     failure can be followed from the Workers log to the dead-letter queue.
 */
import { getLogger } from '@/server/logging/logger';
import * as organizationRepository from '@/server/repositories/organization.repository';
import * as userRepository from '@/server/repositories/user.repository';
import * as notificationRepository from '@/server/repositories/notification.repository';
import { driveSyncService } from '@/server/services/drive-sync.service';
import {
  driveSyncMessageSchema,
  notificationMessageSchema,
  type ConsumerOutcome,
  type QueueKind,
} from './messages';

export interface QueueDelivery {
  queue: QueueKind;
  messageId: string;
  attempts: number;
  body: unknown;
}

/** Exponential, capped: 30 s, 60 s, 120 s … 15 min. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(900, 30 * 2 ** Math.max(0, attempts - 1));
}

/** Bounds for one queued sync run. The cursor carries the rest to the next run. */
const SYNC_MAX_PAGES = 10;
const SYNC_PAGE_SIZE = 100;

export async function processQueueMessage(delivery: QueueDelivery): Promise<ConsumerOutcome> {
  const log = getLogger().child({
    queue: delivery.queue,
    messageId: delivery.messageId,
    attempts: delivery.attempts,
  });

  let result: ConsumerOutcome;
  try {
    result =
      delivery.queue === 'sync'
        ? await consumeDriveSync(delivery.body)
        : await consumeNotifications(delivery.body);
  } catch (error) {
    result = {
      outcome: 'retry',
      reason: error instanceof Error ? error.message : String(error),
      delaySeconds: retryDelaySeconds(delivery.attempts),
    };
  }

  if (result.outcome === 'ack') log.info({ ...result.detail }, 'Queue message processed');
  else if (result.outcome === 'retry') log.warn({ reason: result.reason }, 'Queue message will be retried');
  else log.error({ reason: result.reason }, 'Queue message dropped: it can never succeed');

  return result;
}

/* ------------------------------------------------------------------ Drive sync */

export async function consumeDriveSync(body: unknown): Promise<ConsumerOutcome> {
  const parsed = driveSyncMessageSchema.safeParse(body);
  if (!parsed.success) return { outcome: 'drop', reason: `malformed drive.sync message: ${parsed.error.message}` };

  // The organization is resolved here, not read from the message. There is one per deployment.
  const organization = await organizationRepository.getPrimary();
  if (!organization) return { outcome: 'drop', reason: 'no organization has been set up' };

  const summary = await driveSyncService.syncDriveChanges({
    organizationId: organization.id,
    maxPages: SYNC_MAX_PAGES,
    pageSize: SYNC_PAGE_SIZE,
  });

  if (!summary.ran) {
    return { outcome: 'ack', detail: { skipped: 'Google Drive storage is not enabled' } };
  }
  if (summary.error) {
    // Recorded on the sync state by the service already; retried here so a transient Drive
    // error heals before the next scheduled run, and dead-lettered if it does not.
    return { outcome: 'retry', reason: summary.error, delaySeconds: 60 };
  }

  return {
    outcome: 'ack',
    detail: {
      trigger: parsed.data.trigger,
      initialized: summary.initialized,
      pages: summary.pages,
      changes: summary.changes,
      conflicts: summary.conflicts,
      missing: summary.missing,
      reconciled: summary.reconciled,
    },
  };
}

/* ------------------------------------------------------------------ notifications */

export async function consumeNotifications(body: unknown): Promise<ConsumerOutcome> {
  const parsed = notificationMessageSchema.safeParse(body);
  if (!parsed.success) {
    return { outcome: 'drop', reason: `malformed notifications message: ${parsed.error.message}` };
  }

  const { notifications } = parsed.data;
  const recipients = await userRepository.findByIds([...new Set(notifications.map((n) => n.userId))]);
  const eligible = new Map(
    recipients
      .filter((user) => user.status === 'active')
      .map((user) => [user.id, user.organizationId] as const),
  );

  // A recipient who was deactivated, deleted or moved between enqueue and delivery simply does
  // not get the notification. That is the same answer the inline path would have given a moment
  // later, and it is never a reason to retry.
  const deliverable = notifications.filter((n) => eligible.get(n.userId) === n.organizationId);

  if (deliverable.length > 0) await notificationRepository.createMany(deliverable);

  return {
    outcome: 'ack',
    detail: { received: notifications.length, written: deliverable.length },
  };
}
