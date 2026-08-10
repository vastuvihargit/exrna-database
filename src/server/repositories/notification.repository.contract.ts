/**
 * Notifications — the shape both engines implement.
 *
 * ── Access control is the `userId` parameter, and there is no other ─────────────────────
 *
 * Every read on this interface takes a `userId` and is scoped to it. There is deliberately no
 * `findById(id)`, because such a method would return a row belonging to whoever owned it and
 * every caller would then have to remember to compare the recipient. One forgotten comparison
 * is another employee's notification feed.
 *
 * `markRead` takes both the notification id *and* the user id for the same reason: the id alone
 * is guessable, and a bare `UPDATE … WHERE id = ?` would let anyone mark anyone's notification
 * read. It is a small harm, but it is an authorization hole and it costs one extra predicate.
 *
 * ── Notifications carry labels, never content ───────────────────────────────────────────
 *
 * `entityLabel` is a filename or a project name; the body of the thing stays behind the
 * permission check on the file itself. A notification is a pointer, not a copy — which is what
 * makes it safe for it to outlive a permission change.
 *
 * ── `dedupeKey` exists because Queue delivery is at-least-once ──────────────────────────
 *
 * Cloudflare Queues redeliver on retry, and the same event arriving twice must not produce two
 * rows in somebody's bell menu. Callers that write from a Queue consumer pass a key derived from
 * the *event*, not from the clock — `review-requested:<reviewId>:<userId>` — and both engines
 * turn a repeat into a no-op rather than a second row or an error.
 *
 * Optional, because the paths that write inline from a request are already exactly-once: there
 * is no retry to deduplicate, and inventing a key for them would make two identical-but-genuine
 * notifications (the same person shares the same file with you twice) collapse into one.
 */
import type { NotificationType } from '@/server/db/models';

export type { NotificationType };

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  actorUserId: string | null;
  actorName: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  message: string;
  readAt: Date | null;
  createdAt: Date;
}

export interface CreateNotificationInput {
  organizationId: string;
  userId: string;
  type: NotificationType;
  actorUserId?: string | null;
  actorName?: string;
  entityType: string;
  entityId: string;
  entityLabel?: string;
  message: string;
  /** Set by Queue consumers. See the header. */
  dedupeKey?: string | null;
}

export interface NotificationRepository {
  /** Idempotent when `dedupeKey` is set: a repeat is a no-op, not a second row or an error. */
  create(input: CreateNotificationInput): Promise<void>;
  /** Bulk insert for a fan-out (review requests to several reviewers). */
  createMany(inputs: CreateNotificationInput[]): Promise<void>;
  listForUser(
    userId: string,
    options?: { unreadOnly?: boolean; limit?: number },
  ): Promise<NotificationRecord[]>;
  countUnread(userId: string): Promise<number>;
  /** Scoped to the recipient — see the header. Returns false when nothing matched. */
  markRead(userId: string, notificationId: string): Promise<boolean>;
  markAllRead(userId: string): Promise<number>;
  /**
   * Removes notifications pointing at an entity that no longer exists.
   *
   * Called when a file is purged. A notification that outlives its subject is a dangling
   * reference to a name the recipient can no longer verify.
   */
  purgeForEntities(entityIds: string[]): Promise<number>;
}

/** The page cap, shared so both engines truncate identically. */
export const MAX_NOTIFICATION_PAGE = 100;
export const DEFAULT_NOTIFICATION_PAGE = 50;
