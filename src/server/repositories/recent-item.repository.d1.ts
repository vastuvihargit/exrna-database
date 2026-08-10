/**
 * The D1 recent-items repository.
 *
 * ── The upsert has to update, not ignore ────────────────────────────────────────────────
 *
 * `stars` uses `ON CONFLICT DO NOTHING` because re-starring must not reorder the list. Recent
 * is the opposite: the whole point of touching an item again is to move it to the top, so the
 * conflict branch writes `last_accessed_at` and `last_action`. `organization_id` is left alone
 * in that branch, mirroring Mongo's `$setOnInsert` — a row's tenant is set once and is not
 * something an access should be able to rewrite.
 *
 * ── Why `touch` must never throw into the caller's path ─────────────────────────────────
 *
 * Both call sites are `void`-ed fire-and-forget: recording that somebody opened a file is not
 * worth failing the open over. That is the caller's decision and it is unchanged here, but it
 * means this module must not be given retry logic or a transaction — a slow recent-write would
 * become a slow file read.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getD1 } from '@/server/db/d1-context';
import { inList } from '@/server/db/d1-bindings';
import { recentItems } from '@/server/db/schema/audit';
import type {
  RecentEntityType,
  RecentItemRepository,
  RecentRef,
  TouchRecentInput,
} from './recent-item.repository.contract';

export async function touch(input: TouchRecentInput): Promise<void> {
  const db = await getD1();
  const now = new Date().toISOString();
  const lastAction = input.action ?? 'opened';

  await db
    .insert(recentItems)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      organizationId: input.organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      lastAction,
      lastAccessedAt: now,
    })
    .onConflictDoUpdate({
      target: [recentItems.userId, recentItems.entityType, recentItems.entityId],
      set: { lastAccessedAt: now, lastAction },
    });
}

export async function listForUser(
  userId: string,
  options: { entityType?: RecentEntityType; limit?: number } = {},
): Promise<RecentRef[]> {
  const db = await getD1();
  const where = options.entityType
    ? and(eq(recentItems.userId, userId), eq(recentItems.entityType, options.entityType))!
    : eq(recentItems.userId, userId);

  const rows = await db
    .select({
      entityType: recentItems.entityType,
      entityId: recentItems.entityId,
      lastAction: recentItems.lastAction,
      lastAccessedAt: recentItems.lastAccessedAt,
    })
    .from(recentItems)
    .where(where)
    // The id tiebreak keeps the order stable when two items are touched in the same
    // millisecond, which is routine when a folder open touches the folder and its contents.
    .orderBy(desc(recentItems.lastAccessedAt), desc(recentItems.entityId))
    .limit(options.limit ?? 50);

  return rows.map((row) => ({
    entityType: row.entityType,
    entityId: row.entityId,
    lastAction: row.lastAction,
    lastAccessedAt: new Date(row.lastAccessedAt),
  }));
}

export async function removeAllFor(
  entityType: RecentEntityType,
  entityIds: string[],
): Promise<void> {
  const unique = [...new Set(entityIds)];
  if (unique.length === 0) return;

  const db = await getD1();
  await db
    .delete(recentItems)
    .where(and(eq(recentItems.entityType, entityType), inList(recentItems.entityId, unique)));
}

export const d1RecentItemRepository: RecentItemRepository = {
  touch,
  listForUser,
  removeAllFor,
};
