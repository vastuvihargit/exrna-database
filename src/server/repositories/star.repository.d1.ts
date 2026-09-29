/**
 * The D1 star repository.
 *
 * ── `INSERT … ON CONFLICT DO NOTHING`, not read-then-write ──────────────────────────────
 *
 * `add()` is called from a toggle a user can double-click, and from two browser tabs at once.
 * A `SELECT` followed by an `INSERT` would let both attempts see "not starred" and both insert,
 * which the `ux_stars` unique index turns into a 500 on the second one — a failure for an
 * action that had already succeeded. The upsert makes the second write a no-op inside the
 * engine, which is what "idempotent" has to mean when two writers race.
 *
 * ── `entity_id` is not a foreign key, deliberately ──────────────────────────────────────
 *
 * `stars.entity_id` is polymorphic: a folder id or a file id, distinguished by `entity_type`.
 * SQLite cannot express a conditional reference, so the column carries none. That is a real
 * cost — a star can outlive the thing it points at — and it is paid the same way MongoDB paid
 * it: `removeAllFor` is called by the purge, and `listForUser` hands its ids to a
 * permission-aware `findByIds` which simply does not return rows that no longer exist. A
 * dangling star is invisible rather than broken.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getD1 } from '@/server/db/d1-context';
import { inList } from '@/server/db/d1-bindings';
import { stars } from '@/server/db/schema/audit';
import type {
  AddStarInput,
  RemoveStarInput,
  StarRef,
  StarRepository,
  StarrableType,
} from './star.repository.contract';

export async function add(input: AddStarInput): Promise<void> {
  const db = await getD1();
  await db
    .insert(stars)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      organizationId: input.organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      createdAt: new Date().toISOString(),
    })
    // Matches Mongo's `$setOnInsert`: the original star keeps its original timestamp, so
    // re-starring does not reorder the Starred page.
    .onConflictDoNothing({ target: [stars.userId, stars.entityType, stars.entityId] });
}

export async function remove(input: RemoveStarInput): Promise<void> {
  const db = await getD1();
  await db
    .delete(stars)
    .where(
      and(
        eq(stars.userId, input.userId),
        eq(stars.entityType, input.entityType),
        eq(stars.entityId, input.entityId),
      ),
    );
}

export async function starredIdsAmong(
  userId: string,
  entityType: StarrableType,
  entityIds: string[],
): Promise<Set<string>> {
  const unique = [...new Set(entityIds)];
  if (unique.length === 0) return new Set();

  const db = await getD1();
  // `inList`, not `inArray`: this is called with a whole page of ids to annotate a listing,
  // and D1 caps a statement at 100 bound parameters. See `d1-bindings.ts`.
  const rows = await db
    .select({ entityId: stars.entityId })
    .from(stars)
    .where(
      and(
        eq(stars.userId, userId),
        eq(stars.entityType, entityType),
        inList(stars.entityId, unique),
      ),
    );

  return new Set(rows.map((row) => row.entityId));
}

export async function listForUser(
  userId: string,
  options: { entityType?: StarrableType; limit?: number } = {},
): Promise<StarRef[]> {
  const db = await getD1();
  const where = options.entityType
    ? and(eq(stars.userId, userId), eq(stars.entityType, options.entityType))!
    : eq(stars.userId, userId);

  const rows = await db
    .select({
      entityType: stars.entityType,
      entityId: stars.entityId,
      createdAt: stars.createdAt,
    })
    .from(stars)
    .where(where)
    .orderBy(desc(stars.createdAt), desc(stars.entityId))
    .limit(options.limit ?? 200);

  return rows.map((row) => ({
    entityType: row.entityType,
    entityId: row.entityId,
    createdAt: new Date(row.createdAt),
  }));
}

export async function removeAllFor(
  entityType: StarrableType,
  entityIds: string[],
): Promise<void> {
  const unique = [...new Set(entityIds)];
  if (unique.length === 0) return;

  const db = await getD1();
  await db
    .delete(stars)
    .where(and(eq(stars.entityType, entityType), inList(stars.entityId, unique)));
}

export const d1StarRepository: StarRepository = {
  add,
  remove,
  starredIdsAmong,
  listForUser,
  removeAllFor,
};
