/**
 * The D1 session repository.
 *
 * ── ISO-8601 TEXT compares correctly, and that is load-bearing ──────────────────────────
 *
 * Every timestamp here is `Date.prototype.toISOString()` output: fixed width, UTC, millisecond
 * precision. Lexicographic comparison of two such strings is chronological comparison, which is
 * what makes `expires_at > ?` a valid liveness test in SQLite — the same predicate MongoDB
 * expressed against a real date type.
 *
 * It is only valid because the format never varies. Anything that wrote a local-time string, a
 * second-precision string or a Unix integer into one of these columns would produce a
 * comparison that silently returns the wrong answer, and the wrong answer here is either
 * "expired session accepted" or "every user logged out". `isoOrNull` is the one conversion
 * point, and nothing in this file formats a date any other way.
 *
 * ── `touch` caps in SQL, not in JavaScript ──────────────────────────────────────────────
 *
 * MongoDB used `$min: [idleExpiresAt, '$absoluteExpiresAt']` so the idle window could never
 * push a session past its absolute expiry. Reading the row, comparing in JS and writing back
 * would reintroduce a race that the pipeline did not have: two concurrent requests for the same
 * session both read, both decide, and the later write wins with a stale value. SQLite's `MIN()`
 * over the column keeps the decision inside the single statement.
 *
 * ── `revokeAllForUser` reports rows changed ─────────────────────────────────────────────
 *
 * The `revoked_at IS NULL` predicate is in the WHERE clause, so `meta.changes` counts only
 * sessions this call actually revoked. Matching on user alone and reporting the match count
 * would inflate the audit record with sessions that were already dead.
 */
import { and, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import { getD1 } from '@/server/db/d1-context';
import { loginHistory, sessions } from '@/server/db/schema/audit';
import type {
  CreateSessionInput,
  LiveSessionRecord,
  SessionRecord,
  SessionRepository,
  SessionRevokeReason,
} from './session.repository.contract';

/** The single date-formatting point in this file. See the header. */
function iso(value: Date): string {
  return value.toISOString();
}

function isoOrNull(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

interface SessionRow {
  id: string;
  userId: string;
  organizationId: string;
  expiresAt: string;
  absoluteExpiresAt: string;
  lastUsedAt: string;
  createdAt: string;
  ip: string;
  userAgent: string;
  deviceLabel: string;
  provider: string;
  revokedAt: string | null;
  rotatedAt: string | null;
}

const recordColumns = {
  id: sessions.id,
  userId: sessions.userId,
  organizationId: sessions.organizationId,
  expiresAt: sessions.expiresAt,
  absoluteExpiresAt: sessions.absoluteExpiresAt,
  lastUsedAt: sessions.lastUsedAt,
  createdAt: sessions.createdAt,
  ip: sessions.ip,
  userAgent: sessions.userAgent,
  deviceLabel: sessions.deviceLabel,
  provider: sessions.provider,
  revokedAt: sessions.revokedAt,
  rotatedAt: sessions.rotatedAt,
} as const;

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    organizationId: row.organizationId,
    expiresAt: new Date(row.expiresAt),
    absoluteExpiresAt: new Date(row.absoluteExpiresAt),
    lastUsedAt: new Date(row.lastUsedAt),
    createdAt: new Date(row.createdAt),
    ip: row.ip,
    userAgent: row.userAgent,
    deviceLabel: row.deviceLabel,
    provider: row.provider,
    revokedAt: isoOrNull(row.revokedAt),
    rotatedAt: isoOrNull(row.rotatedAt),
  };
}

export async function create(input: CreateSessionInput): Promise<SessionRecord> {
  const db = await getD1();
  const now = iso(new Date());

  const [row] = await db
    .insert(sessions)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      organizationId: input.organizationId,
      tokenHash: input.tokenHash,
      csrfTokenHash: input.csrfTokenHash,
      expiresAt: iso(input.expiresAt),
      absoluteExpiresAt: iso(input.absoluteExpiresAt),
      lastUsedAt: now,
      rotatedFromId: input.rotatedFromId ?? null,
      ip: input.ip,
      userAgent: input.userAgent,
      deviceLabel: input.deviceLabel,
      provider: input.provider,
      createdAt: now,
      updatedAt: now,
    })
    .returning(recordColumns);

  return toRecord(row as SessionRow);
}

export async function findLiveByTokenHash(tokenHash: string): Promise<LiveSessionRecord | null> {
  const db = await getD1();
  const now = iso(new Date());

  // Liveness is three predicates in the WHERE clause, exactly as MongoDB had it. A caller
  // cannot opt out of them, which is the point.
  const [row] = await db
    .select({ ...recordColumns, csrfTokenHash: sessions.csrfTokenHash })
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        gt(sessions.absoluteExpiresAt, now),
      ),
    )
    .limit(1);

  if (!row) return null;
  return { ...toRecord(row as SessionRow), csrfTokenHash: row.csrfTokenHash };
}

export async function touch(id: string, idleExpiresAt: Date): Promise<void> {
  const db = await getD1();
  const now = iso(new Date());

  await db
    .update(sessions)
    .set({
      lastUsedAt: now,
      // MIN over the column, not over a value read a moment ago — see the header.
      expiresAt: sql`MIN(${iso(idleExpiresAt)}, ${sessions.absoluteExpiresAt})`,
      updatedAt: now,
    })
    .where(eq(sessions.id, id));
}

export async function revoke(id: string, reason: SessionRevokeReason): Promise<void> {
  const db = await getD1();
  const now = iso(new Date());

  await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
}

export async function revokeAllForUser(
  userId: string,
  reason: SessionRevokeReason,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  const db = await getD1();
  const now = iso(new Date());

  const where = options.exceptSessionId
    ? and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        ne(sessions.id, options.exceptSessionId),
      )
    : and(eq(sessions.userId, userId), isNull(sessions.revokedAt));

  const result = await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
    .where(where);

  // `meta.changes` is rows actually written, which is what the caller reports. See the header.
  return (result as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

export async function listForUser(userId: string): Promise<SessionRecord[]> {
  const db = await getD1();
  const now = iso(new Date());

  const rows = await db
    .select(recordColumns)
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.absoluteExpiresAt, now),
      ),
    )
    // `id` breaks the tie so the page is stable when two sessions share a `lastUsedAt`
    // millisecond, which the throttled `touch` makes likelier than it sounds.
    .orderBy(sql`${sessions.lastUsedAt} DESC, ${sessions.id} DESC`)
    .limit(50);

  return rows.map((row) => toRecord(row as SessionRow));
}

export async function findById(id: string): Promise<SessionRecord | null> {
  const db = await getD1();
  const [row] = await db.select(recordColumns).from(sessions).where(eq(sessions.id, id)).limit(1);
  return row ? toRecord(row as SessionRow) : null;
}

export async function markRotated(id: string): Promise<void> {
  const db = await getD1();
  const now = iso(new Date());

  await db
    .update(sessions)
    .set({ rotatedAt: now, revokedAt: now, revokedReason: 'rotated', updatedAt: now })
    .where(eq(sessions.id, id));
}

/**
 * The sweep that replaces MongoDB's TTL index.
 *
 * Two columns point at `sessions.id` and neither cascades: `login_history.session_id`, which is
 * how the admin security view links an attempt to the session it produced, and
 * `sessions.rotated_from_id`, which chains a rotated session to its predecessor. D1 enforces
 * foreign keys, so a bare `DELETE` fails the moment a swept session has ever been referenced —
 * which, for `login_history`, is every session that was ever logged into.
 *
 * Detaching the references is the right answer rather than cascading: a login-history row is a
 * security record that must outlive the session it describes. It keeps its user, its IP and its
 * outcome and loses only the pointer to a row that no longer exists.
 *
 * All three statements go in one `batch`, so the sweep cannot half-run and leave
 * `login_history` detached from sessions that are still present.
 */
export async function deleteExpiredBefore(cutoff: Date): Promise<number> {
  const db = await getD1();
  const before = iso(cutoff);

  const expired = sql`(SELECT id FROM sessions WHERE absolute_expires_at < ${before})`;

  // Query builders, not `db.run(sql)`: `batch()` takes drizzle statements, and a raw runner is
  // not one — it arrives as `undefined` and fails on `.bind`.
  const [, , deletion] = await db.batch([
    db
      .update(loginHistory)
      .set({ sessionId: null })
      .where(sql`${loginHistory.sessionId} IN ${expired}`),
    db
      .update(sessions)
      .set({ rotatedFromId: null })
      .where(sql`${sessions.rotatedFromId} IN ${expired}`),
    db.delete(sessions).where(lt(sessions.absoluteExpiresAt, before)),
  ]);

  return (deletion as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 0;
}

export const d1SessionRepository: SessionRepository = {
  create,
  findLiveByTokenHash,
  touch,
  revoke,
  revokeAllForUser,
  listForUser,
  findById,
  markRotated,
  deleteExpiredBefore,
};
