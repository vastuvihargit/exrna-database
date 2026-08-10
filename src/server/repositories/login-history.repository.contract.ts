/**
 * Login history — the shape both engines implement.
 *
 * Every authentication attempt, successful or not. `userId` is null when the address matches no
 * account: the row still records the attempt, which is what makes credential stuffing visible in
 * the admin view rather than invisible.
 *
 * ── This is on the login path, and it must never break a login ──────────────────────────
 *
 * `record()` is called from `auth.service.ts` on every attempt — including the failing ones,
 * before the error is thrown. If writing it can fail, a transient database problem turns "wrong
 * password" into a 500, and worse, an attacker who can make this write fail can suppress their
 * own audit trail.
 *
 * So `record()` returns `Promise<void>` and **both implementations swallow their own errors**
 * after logging them. This is the one place in the repository layer where that is correct:
 * the permanent record of a security event is the audit log, which has no expiry and is written
 * separately. Losing a login-history row degrades a diagnostic view; failing the request would
 * degrade authentication.
 *
 * ── Retention ──────────────────────────────────────────────────────────────────────────
 *
 * MongoDB expired these with a 400-day TTL index. SQLite has no TTL, so `deleteOlderThan`
 * exists on both engines and the cleanup job calls it — the same arrangement as sessions.
 */
import type { LoginOutcome } from '@/server/db/models';

export type { LoginOutcome };

export interface LoginAttemptInput {
  userId?: string | null;
  email: string;
  outcome: LoginOutcome;
  provider?: string;
  ip?: string;
  userAgent?: string;
  sessionId?: string | null;
  detail?: string | null;
}

export interface LoginHistoryRecord {
  id: string;
  userId: string | null;
  email: string;
  outcome: LoginOutcome;
  provider: string;
  ip: string;
  userAgent: string;
  detail: string | null;
  createdAt: Date;
}

export interface AdminLoginHistoryQuery {
  email?: string;
  outcome?: LoginOutcome;
  page: number;
  pageSize: number;
}

export interface LoginHistoryRepository {
  /** Never throws. See the header — a failed write here must not fail the login. */
  record(input: LoginAttemptInput): Promise<void>;
  listForUser(userId: string, limit?: number): Promise<LoginHistoryRecord[]>;
  query(options: AdminLoginHistoryQuery): Promise<{ items: LoginHistoryRecord[]; total: number }>;
  /** Replaces MongoDB's 400-day TTL index. Returns how many rows were removed. */
  deleteOlderThan(cutoff: Date): Promise<number>;
}

/** The admin view's hard ceiling, shared so both engines truncate identically. */
export const MAX_LOGIN_HISTORY_PAGE = 200;
