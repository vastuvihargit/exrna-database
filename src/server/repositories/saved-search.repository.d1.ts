/**
 * The D1 saved-search repository.
 *
 * ── `criteria` is TEXT holding JSON, and stays opaque here ──────────────────────────────
 *
 * The Mongo document stored a sub-object; D1 stores the same object serialized. This module
 * does not validate it — `search.service.ts` re-parses every criteria blob through
 * `searchQuerySchema.parse()` on the way out, which is the check that matters, because a
 * criteria object written months ago by an older schema must be rejected at *use* rather than
 * trusted because it was accepted at *save*.
 *
 * A row whose JSON will not parse at all is returned as `{}` rather than throwing. One
 * corrupted saved search must not make the saved-search list un-openable, and an empty
 * criteria object is the safe reading: the search service treats it as "no criteria" and
 * shows guidance instead of results.
 *
 * ── Ownership is in the WHERE clause, never in a later `if` ─────────────────────────────
 *
 * Every method that takes an id also takes the `userId` and puts both in the predicate. There
 * is no `findById` on this repository at all, so there is no shape in which a route could read
 * somebody else's saved search and forget to compare owners afterwards.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { getD1 } from '@/server/db/d1-context';
import { savedSearches } from '@/server/db/schema/audit';
import type {
  SavedSearchRecord,
  SavedSearchRepository,
  UpsertSavedSearchInput,
} from './saved-search.repository.contract';

type SavedSearchRow = typeof savedSearches.$inferSelect;

function parseCriteria(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toRecord(row: SavedSearchRow): SavedSearchRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    criteria: parseCriteria(row.criteria),
    isPinned: Boolean(row.isPinned),
    lastRunAt: row.lastRunAt ? new Date(row.lastRunAt) : null,
    runCount: row.runCount,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export async function listForUser(userId: string): Promise<SavedSearchRecord[]> {
  const db = await getD1();
  const rows = await db
    .select()
    .from(savedSearches)
    .where(eq(savedSearches.userId, userId))
    // `isPinned` is stored as 0/1, so descending puts pinned first — the same order Mongo's
    // `{ isPinned: -1, updatedAt: -1 }` produces.
    .orderBy(desc(savedSearches.isPinned), desc(savedSearches.updatedAt), desc(savedSearches.id))
    .limit(100);
  return rows.map(toRecord);
}

export async function findOwned(
  userId: string,
  id: string,
): Promise<SavedSearchRecord | null> {
  const db = await getD1();
  const [row] = await db
    .select()
    .from(savedSearches)
    .where(and(eq(savedSearches.id, id), eq(savedSearches.userId, userId)))
    .limit(1);
  return row ? toRecord(row) : null;
}

export async function upsert(input: UpsertSavedSearchInput): Promise<SavedSearchRecord> {
  const db = await getD1();
  const now = new Date().toISOString();
  const nameLower = input.name.toLowerCase();

  const [row] = await db
    .insert(savedSearches)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      name: input.name,
      nameLower,
      criteria: JSON.stringify(input.criteria),
      isPinned: input.isPinned ?? false,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [savedSearches.userId, savedSearches.nameLower],
      set: {
        name: input.name,
        criteria: JSON.stringify(input.criteria),
        updatedAt: now,
        // Absent means "leave the pin as it is", matching the conditional `$set` on Mongo.
        ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
      },
    })
    .returning();

  return toRecord(row!);
}

export async function update(
  userId: string,
  id: string,
  changes: { name?: string; isPinned?: boolean },
): Promise<SavedSearchRecord | null> {
  const set: Partial<typeof savedSearches.$inferInsert> = {};
  if (changes.name !== undefined) {
    set.name = changes.name;
    set.nameLower = changes.name.toLowerCase();
  }
  if (changes.isPinned !== undefined) set.isPinned = changes.isPinned;
  if (Object.keys(set).length === 0) return findOwned(userId, id);

  const db = await getD1();
  const [row] = await db
    .update(savedSearches)
    .set({ ...set, updatedAt: new Date().toISOString() })
    .where(and(eq(savedSearches.id, id), eq(savedSearches.userId, userId)))
    .returning();

  return row ? toRecord(row) : null;
}

export async function remove(userId: string, id: string): Promise<boolean> {
  const db = await getD1();
  const rows = await db
    .delete(savedSearches)
    .where(and(eq(savedSearches.id, id), eq(savedSearches.userId, userId)))
    .returning({ id: savedSearches.id });
  return rows.length > 0;
}

export async function markRun(userId: string, id: string): Promise<void> {
  const db = await getD1();
  const now = new Date().toISOString();
  await db
    .update(savedSearches)
    .set({
      lastRunAt: now,
      // `updatedAt` moves too. Mongoose's `timestamps` bumps it on this update, and
      // `listForUser` orders by it — leaving it alone here would put a just-run search in a
      // different position on the two engines.
      updatedAt: now,
      // Incremented in the statement, not read-then-written: two tabs re-running the same
      // saved search must both be counted.
      runCount: sql`${savedSearches.runCount} + 1`,
    })
    .where(and(eq(savedSearches.id, id), eq(savedSearches.userId, userId)));
}

export const d1SavedSearchRepository: SavedSearchRepository = {
  listForUser,
  findOwned,
  upsert,
  update,
  remove,
  markRun,
};
