/**
 * Session repository — a façade over the MongoDB and D1 implementations.
 *
 * Lookup is by SHA-256 of the cookie value — the raw token is never stored, so a database dump
 * yields nothing replayable. That is true of both engines and is the reason `tokenHash` is the
 * only lookup key on the surface.
 *
 * Routed by `DATA_SOURCE_SESSIONS`.
 *
 * ── This flag is not independently movable, and that is worth stating ───────────────────
 *
 * Most modules in this migration can be flipped on their own: a star in D1 pointing at a file
 * in MongoDB still resolves, because the star repository only returns ids. Sessions are
 * different in both directions.
 *
 * `sessions.user_id` and `sessions.organization_id` are real foreign keys in D1, so a session
 * cannot be written there unless the user and the organization are there too — this flag
 * requires `DATA_SOURCE_USERS=d1` and `DATA_SOURCE_ORGANIZATIONS=d1`, and
 * `assertDataSourceMatrix()` in `data-source.ts` refuses the combination that gets it wrong.
 *
 * The other direction is operational rather than structural: moving this flag invalidates every
 * session that exists, because the new engine has none of them. Every user is logged out at the
 * moment of the flip. That is a cutover step, not a defect, and it is why the runbook puts this
 * flag inside the write freeze.
 */
import { isD1 } from './data-source';
import { mongoSessionRepository } from './session.repository.mongo';
import { d1SessionRepository } from './session.repository.d1';
import type {
  CreateSessionInput,
  LiveSessionRecord,
  SessionRecord,
  SessionRepository,
  SessionRevokeReason,
} from './session.repository.contract';

export type {
  CreateSessionInput,
  LiveSessionRecord,
  SessionRecord,
  SessionRepository,
  SessionRevokeReason,
};

export { mongoSessionRepository, d1SessionRepository };

function active(): SessionRepository {
  return isD1('sessions') ? d1SessionRepository : mongoSessionRepository;
}

export function create(input: CreateSessionInput): Promise<SessionRecord> {
  return active().create(input);
}

export function findLiveByTokenHash(tokenHash: string): Promise<LiveSessionRecord | null> {
  return active().findLiveByTokenHash(tokenHash);
}

export function touch(id: string, idleExpiresAt: Date): Promise<void> {
  return active().touch(id, idleExpiresAt);
}

export function revoke(id: string, reason: SessionRevokeReason): Promise<void> {
  return active().revoke(id, reason);
}

export function revokeAllForUser(
  userId: string,
  reason: SessionRevokeReason,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  return active().revokeAllForUser(userId, reason, options);
}

export function listForUser(userId: string): Promise<SessionRecord[]> {
  return active().listForUser(userId);
}

export function findById(id: string): Promise<SessionRecord | null> {
  return active().findById(id);
}

export function markRotated(id: string): Promise<void> {
  return active().markRotated(id);
}

export function deleteExpiredBefore(cutoff: Date): Promise<number> {
  return active().deleteExpiredBefore(cutoff);
}
