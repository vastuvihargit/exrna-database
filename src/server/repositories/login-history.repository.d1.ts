/**
 * The D1 login-history repository.
 *
 * ── `session_id` and `user_id` are foreign keys, and this write must not fail ───────────
 *
 * `login_history.user_id` references `users.id` and `login_history.session_id` references
 * `sessions.id`. D1 enforces both. That is a problem unique to this table, because the row is
 * written on the *failing* login paths too — including `unknown_user`, where by definition there
 * is no user to reference.
 *
 * Two consequences, and both are handled here rather than left to callers:
 *
 *   1. A `userId` that does not resolve to a row would abort the insert. The Mongo path stored
 *      whatever ObjectId it was handed; D1 cannot. Since the email is recorded regardless and is
 *      the field the admin view searches on, an unresolvable id is dropped to NULL rather than
 *      allowed to fail the write.
 *   2. Same for `sessionId` — and note the sweep in `session.repository.d1.ts` deliberately nulls
 *      this column rather than cascading, precisely so these rows outlive their sessions.
 *
 * Combined with the contract's rule that `record()` never throws, the guarantee is: a login
 * attempt is recorded if it can be, and a login is never failed by the attempt to record it.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { getD1 } from '@/server/db/d1-context';
import { loginHistory, sessions } from '@/server/db/schema/audit';
import { users } from '@/server/db/schema/identity';
import { getLogger } from '@/server/logging/logger';
import {
  MAX_LOGIN_HISTORY_PAGE,
  type AdminLoginHistoryQuery,
  type LoginAttemptInput,
  type LoginHistoryRecord,
  type LoginHistoryRepository,
  type LoginOutcome,
} from './login-history.repository.contract';

interface LoginRow {
  id: string;
  userId: string | null;
  email: string;
  outcome: string;
  provider: string;
  ip: string;
  userAgent: string;
  detail: string | null;
  createdAt: string;
}

const recordColumns = {
  id: loginHistory.id,
  userId: loginHistory.userId,
  email: loginHistory.email,
  outcome: loginHistory.outcome,
  provider: loginHistory.provider,
  ip: loginHistory.ip,
  userAgent: loginHistory.userAgent,
  detail: loginHistory.detail,
  createdAt: loginHistory.createdAt,
} as const;

function toRecord(row: LoginRow): LoginHistoryRecord {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    outcome: row.outcome as LoginOutcome,
    provider: row.provider,
    ip: row.ip,
    userAgent: row.userAgent,
    detail: row.detail,
    createdAt: new Date(row.createdAt),
  };
}

export async function record(input: LoginAttemptInput): Promise<void> {
  try {
    const db = await getD1();

    // Resolve both references before inserting. See the header: an id that does not exist
    // would abort the write, and the row is worth more than the pointer.
    const [userId, sessionId] = await Promise.all([
      input.userId
        ? db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, input.userId))
            .limit(1)
            .then((rows) => rows[0]?.id ?? null)
        : Promise.resolve(null),
      input.sessionId
        ? db
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.id, input.sessionId))
            .limit(1)
            .then((rows) => rows[0]?.id ?? null)
        : Promise.resolve(null),
    ]);

    await db.insert(loginHistory).values({
      id: crypto.randomUUID(),
      userId,
      email: input.email.toLowerCase(),
      outcome: input.outcome,
      provider: input.provider ?? 'password',
      ip: input.ip ?? 'unknown',
      userAgent: input.userAgent ?? 'unknown',
      sessionId,
      detail: input.detail ?? null,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    getLogger().error({ err: error, outcome: input.outcome }, 'Could not record a login attempt');
  }
}

export async function listForUser(userId: string, limit = 50): Promise<LoginHistoryRecord[]> {
  const db = await getD1();
  const rows = await db
    .select(recordColumns)
    .from(loginHistory)
    .where(eq(loginHistory.userId, userId))
    // `id` breaks the tie: several attempts can share a millisecond under a credential-stuffing
    // run, which is exactly when this view is being read.
    .orderBy(desc(loginHistory.createdAt), desc(loginHistory.id))
    .limit(Math.min(limit, MAX_LOGIN_HISTORY_PAGE));

  return rows.map((row) => toRecord(row as LoginRow));
}

export async function query(
  options: AdminLoginHistoryQuery,
): Promise<{ items: LoginHistoryRecord[]; total: number }> {
  const db = await getD1();

  const filters = [
    ...(options.email ? [eq(loginHistory.email, options.email.toLowerCase())] : []),
    ...(options.outcome ? [eq(loginHistory.outcome, options.outcome)] : []),
  ];
  const where = filters.length > 0 ? and(...filters) : undefined;

  const pageSize = Math.min(options.pageSize, MAX_LOGIN_HISTORY_PAGE);

  const [items, totals] = await Promise.all([
    db
      .select(recordColumns)
      .from(loginHistory)
      .where(where)
      .orderBy(desc(loginHistory.createdAt), desc(loginHistory.id))
      .limit(pageSize)
      .offset((options.page - 1) * pageSize),
    db.select({ count: sql<number>`COUNT(*)` }).from(loginHistory).where(where),
  ]);

  return {
    items: items.map((row) => toRecord(row as LoginRow)),
    total: Number(totals[0]?.count ?? 0),
  };
}

export async function deleteOlderThan(cutoff: Date): Promise<number> {
  const db = await getD1();
  const result = await db
    .delete(loginHistory)
    .where(lt(loginHistory.createdAt, cutoff.toISOString()));
  return (result as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

export const d1LoginHistoryRepository: LoginHistoryRepository = {
  record,
  listForUser,
  query,
  deleteOlderThan,
};
