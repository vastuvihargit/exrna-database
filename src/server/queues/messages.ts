/**
 * The two queue message shapes, stated once and validated on both ends.
 *
 * ── A message is a request to do work, never a grant of authority ───────────────────────
 *
 * Anything in a message body is treated as untrusted input, exactly like a request body. The
 * consumer re-derives what it needs from the database: the Drive-sync consumer resolves the
 * organization itself rather than taking one from the payload, and the notification consumer
 * re-checks that each recipient exists, is active and belongs to the organization named. A
 * message cannot make the application do anything its producer could not already have done
 * inline.
 *
 * ── Versioned, strict ───────────────────────────────────────────────────────────────────
 *
 * `.strict()` so an unexpected field is a rejection rather than silently ignored — a message
 * written by a newer deployment during a rollout is visible as "not understood" instead of
 * half-processed.
 */
import { z } from 'zod';
import { NOTIFICATION_TYPES } from '@/server/db/models/notification.model';
import { MAINTENANCE_JOBS } from '@/server/services/maintenance-jobs';

export const QUEUE_KINDS = ['sync', 'notifications'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

/* ------------------------------------------------------------------ Drive sync */

export const driveSyncMessageSchema = z
  .object({
    kind: z.literal('drive.sync'),
    /** Informational: who asked. The consumer behaves identically for both. */
    trigger: z.enum(['cron', 'manual']),
    requestedAt: z.string().datetime(),
  })
  .strict();

export type DriveSyncMessage = z.infer<typeof driveSyncMessageSchema>;

/* ------------------------------------------------------------------ scheduled maintenance */

/**
 * One scheduled maintenance job (`services/maintenance.service.ts`), enqueued by the Worker's
 * cron trigger (`queues/schedule.ts`) on the same queue as Drive sync. The job name is the only
 * input and is an enum: a message cannot choose an organization, a limit or a target.
 */
export const maintenanceMessageSchema = z
  .object({
    kind: z.literal('maintenance.run'),
    job: z.enum(MAINTENANCE_JOBS),
    trigger: z.enum(['cron', 'manual']),
    requestedAt: z.string().datetime(),
  })
  .strict();

export type MaintenanceMessage = z.infer<typeof maintenanceMessageSchema>;

/** Everything `SYNC_QUEUE` carries. */
export const syncQueueMessageSchema = z.discriminatedUnion('kind', [
  driveSyncMessageSchema,
  maintenanceMessageSchema,
]);

/* ------------------------------------------------------------------ notifications */

const id = z.string().min(1).max(64);

export const queuedNotificationSchema = z
  .object({
    organizationId: id,
    userId: id,
    type: z.enum(NOTIFICATION_TYPES),
    actorUserId: id.nullable().optional(),
    actorName: z.string().max(200).optional(),
    entityType: z.string().min(1).max(40),
    entityId: id,
    entityLabel: z.string().max(500).optional(),
    message: z.string().min(1).max(1000),
    /**
     * Required on the queue path. Delivery is at-least-once; the key is what makes a redelivery
     * a no-op rather than a second row in somebody's bell menu.
     */
    dedupeKey: z.string().min(1).max(300),
  })
  .strict();

export type QueuedNotification = z.infer<typeof queuedNotificationSchema>;

/** Cloudflare caps a message at 128 KB; 50 notifications of ≤ 1 KB each stays well inside. */
export const MAX_NOTIFICATIONS_PER_MESSAGE = 50;

export const notificationMessageSchema = z
  .object({
    kind: z.literal('notifications.create'),
    version: z.literal(1),
    notifications: z.array(queuedNotificationSchema).min(1).max(MAX_NOTIFICATIONS_PER_MESSAGE),
  })
  .strict();

export type NotificationMessage = z.infer<typeof notificationMessageSchema>;

/* ------------------------------------------------------------------ consumer outcome */

/**
 * What the consumer tells the Worker entrypoint to do with a message.
 *
 * `retry` is for failures that may succeed later (a database or Drive hiccup). After the queue's
 * `max_retries` the message lands in the dead-letter queue, which is where a failure becomes
 * visible to an operator. `drop` is for a message that can never succeed — malformed, or naming
 * something that does not exist — and is logged at error level instead of being retried into
 * the dead-letter queue for no benefit.
 */
export type ConsumerOutcome =
  | { outcome: 'ack'; detail?: Record<string, unknown> }
  | { outcome: 'retry'; reason: string; delaySeconds: number }
  | { outcome: 'drop'; reason: string };
