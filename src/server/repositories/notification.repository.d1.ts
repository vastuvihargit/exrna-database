/**
 * The D1 notification repository.
 *
 * ── Deduplication is `ON CONFLICT DO NOTHING`, not a lookup ─────────────────────────────
 *
 * The unique index on `dedupe_key` (migration 0004) is what makes a Queue redelivery a no-op.
 * `INSERT … ON CONFLICT DO NOTHING` lets the engine decide, which is the only place the decision
 * can be made correctly: two concurrent redeliveries of the same message would both pass a
 * `SELECT`-first check and both insert.
 *
 * The rows written inline from a request carry NULL and do not collide, because SQLite treats
 * every NULL in a unique index as distinct — see migration 0004 for why MongoDB needs a
 * different index shape to reach the same behaviour.
 *
 * The conflict target is named rather than left implicit, so only a `dedupe_key` collision is
 * swallowed. A collision on the primary key — which would mean a UUID repeat — still throws, as
 * it should.
 *
 * ── `markRead` carries the recipient in the WHERE clause ────────────────────────────────
 *
 * Not because the caller is untrusted, but because notification ids appear in URLs and an
 * `UPDATE … WHERE id = ?` would let anyone mark anyone's notification read. One extra predicate
 * closes it; the contract explains the general rule.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getD1 } from '@/server/db/d1-context';
import { inList } from '@/server/db/d1-bindings';
import { notifications } from '@/server/db/schema/collaboration';
import {
  DEFAULT_NOTIFICATION_PAGE,
  MAX_NOTIFICATION_PAGE,
  type CreateNotificationInput,
  type NotificationRecord,
  type NotificationRepository,
  type NotificationType,
} from './notification.repository.contract';

interface NotificationRow {
  id: string;
  type: string;
  actorUserId: string | null;
  actorName: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

const recordColumns = {
  id: notifications.id,
  type: notifications.type,
  actorUserId: notifications.actorUserId,
  actorName: notifications.actorName,
  entityType: notifications.entityType,
  entityId: notifications.entityId,
  entityLabel: notifications.entityLabel,
  message: notifications.message,
  readAt: notifications.readAt,
  createdAt: notifications.createdAt,
} as const;

function toRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    type: row.type as NotificationType,
    actorUserId: row.actorUserId,
    actorName: row.actorName ?? '',
    entityType: row.entityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel ?? '',
    message: row.message,
    readAt: row.readAt === null ? null : new Date(row.readAt),
    createdAt: new Date(row.createdAt),
  };
}

function toValues(input: CreateNotificationInput, now: string) {
  return {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    userId: input.userId,
    type: input.type,
    actorUserId: input.actorUserId ?? null,
    actorName: input.actorName ?? '',
    entityType: input.entityType,
    entityId: input.entityId,
    entityLabel: input.entityLabel ?? '',
    message: input.message,
    readAt: null,
    dedupeKey: input.dedupeKey ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function create(input: CreateNotificationInput): Promise<void> {
  const db = await getD1();
  await db
    .insert(notifications)
    .values(toValues(input, new Date().toISOString()))
    .onConflictDoNothing({ target: notifications.dedupeKey });
}

export async function createMany(inputs: CreateNotificationInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const db = await getD1();
  const now = new Date().toISOString();

  // One statement, not one per recipient: a review fan-out writes every row or none, and a
  // partial fan-out is a reviewer who never learns they were asked.
  await db
    .insert(notifications)
    .values(inputs.map((input) => toValues(input, now)))
    .onConflictDoNothing({ target: notifications.dedupeKey });
}

export async function listForUser(
  userId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationRecord[]> {
  const db = await getD1();
  const where = options.unreadOnly
    ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
    : eq(notifications.userId, userId);

  const rows = await db
    .select(recordColumns)
    .from(notifications)
    .where(where)
    // `id` breaks the tie so a fan-out written in one statement — every row sharing a
    // `created_at` to the millisecond — paginates in a stable order.
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(Math.min(options.limit ?? DEFAULT_NOTIFICATION_PAGE, MAX_NOTIFICATION_PAGE));

  return rows.map((row) => toRecord(row as NotificationRow));
}

export async function countUnread(userId: string): Promise<number> {
  const db = await getD1();
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

  return Number(row?.count ?? 0);
}

export async function markRead(userId: string, notificationId: string): Promise<boolean> {
  const db = await getD1();
  const result = await db
    .update(notifications)
    .set({ readAt: new Date().toISOString() })
    .where(
      and(
        eq(notifications.id, notificationId),
        // The recipient predicate — see the header.
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    );

  return ((result as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

export async function markAllRead(userId: string): Promise<number> {
  const db = await getD1();
  const result = await db
    .update(notifications)
    .set({ readAt: new Date().toISOString() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

  return (result as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

export async function purgeForEntities(entityIds: string[]): Promise<number> {
  const unique = [...new Set(entityIds)].filter(Boolean);
  if (unique.length === 0) return 0;

  const db = await getD1();
  // `inList`, not `inArray`: a folder purge passes every file id it contained, and D1 caps a
  // statement at 100 bound parameters. See `d1-bindings.ts`.
  const result = await db.delete(notifications).where(inList(notifications.entityId, unique));

  return (result as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

export const d1NotificationRepository: NotificationRepository = {
  create,
  createMany,
  listForUser,
  countUnread,
  markRead,
  markAllRead,
  purgeForEntities,
};
