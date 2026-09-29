/**
 * Sessions — the shape both engines implement.
 *
 * This is the authentication hot path: `resolveSession()` calls `findLiveByTokenHash` on every
 * single request, so it is also the module that decides whether a Worker can serve a request at
 * all. Nothing else in the migration is reached until this one works.
 *
 * ── Liveness is a property of the query, not of the caller ──────────────────────────────
 *
 * `findLiveByTokenHash` returns a row only if it is unrevoked and inside *both* the idle and
 * the absolute expiry. That condition lives in the WHERE clause rather than in a check the
 * caller performs afterwards, because a caller that forgets the check is an authentication
 * bypass and a query that forgets it is a test failure. Both engines must express it the same
 * way, which is why the contract states it here rather than leaving it to each implementation.
 *
 * ── No Mongoose `ClientSession` parameter ───────────────────────────────────────────────
 *
 * The MongoDB implementation used to accept an optional `ClientSession` on `create` and
 * `revokeAllForUser`. No caller in the repository ever passed one — verified across
 * `auth.service.ts`, `user.service.ts` and `session.service.ts` — so the parameter is dropped
 * rather than carried into a contract D1 cannot honour. Reintroducing cross-engine transaction
 * plumbing on a surface nobody uses would be inventing a requirement.
 *
 * ── Timestamps ──────────────────────────────────────────────────────────────────────────
 *
 * `Date` at this boundary, in both engines. D1 stores ISO-8601 TEXT and converts at the edge;
 * callers never see the difference, and `dto.ts` keeps serialising exactly what it did before.
 */
import type { SessionRevokeReason } from '@/server/db/models';

export type { SessionRevokeReason };

export interface SessionRecord {
  id: string;
  userId: string;
  organizationId: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  lastUsedAt: Date;
  createdAt: Date;
  ip: string;
  userAgent: string;
  deviceLabel: string;
  provider: string;
  revokedAt: Date | null;
  rotatedAt: Date | null;
}

export interface CreateSessionInput {
  userId: string;
  organizationId: string;
  tokenHash: string;
  csrfTokenHash: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  ip: string;
  userAgent: string;
  deviceLabel: string;
  provider: string;
  rotatedFromId?: string | null;
}

/**
 * The CSRF hash travels with the session record on the authentication path only.
 *
 * Kept off `SessionRecord` so that the admin-facing "your active sessions" listing, which
 * serialises whole records, cannot accidentally disclose it.
 */
export type LiveSessionRecord = SessionRecord & { csrfTokenHash: string };

export interface SessionRepository {
  create(input: CreateSessionInput): Promise<SessionRecord>;
  /** Live means: not revoked, and before both expiries. Enforced in the query. */
  findLiveByTokenHash(tokenHash: string): Promise<LiveSessionRecord | null>;
  /** Slides the idle window, capped by the absolute expiry. Throttled by the caller. */
  touch(id: string, idleExpiresAt: Date): Promise<void>;
  revoke(id: string, reason: SessionRevokeReason): Promise<void>;
  /**
   * Revokes every live session for a user, returning how many changed.
   *
   * This is what makes deactivation, password change and role change take effect immediately,
   * so the count is the value the audit record reports — it must be the number of rows the
   * engine actually modified, not the number matched.
   */
  revokeAllForUser(
    userId: string,
    reason: SessionRevokeReason,
    options?: { exceptSessionId?: string },
  ): Promise<number>;
  listForUser(userId: string): Promise<SessionRecord[]>;
  findById(id: string): Promise<SessionRecord | null>;
  markRotated(id: string): Promise<void>;
  /**
   * Removes sessions whose absolute expiry has passed.
   *
   * MongoDB swept these with a TTL index. SQLite has none, so the sweep is explicit — see the
   * note on `ix_sessions_absolute_expiry` in `schema/audit.ts`. Returns the number deleted.
   */
  deleteExpiredBefore(cutoff: Date): Promise<number>;
}
