/**
 * Session lifecycle: issue, validate, rotate, revoke.
 *
 * The value handed to the browser is returned once, here, and never again — only its
 * SHA-256 is persisted. Validation rebuilds the Actor from the database on every
 * request, which is what makes deactivation and permission changes immediate.
 */
import { getEnv } from '@/server/config/env';
import { UnauthenticatedError } from '@/server/errors/app-error';
import * as sessionRepository from '@/server/repositories/session.repository';
import * as userRepository from '@/server/repositories/user.repository';
import * as roleRepository from '@/server/repositories/role.repository';
import type { SessionRevokeReason } from '@/server/db/models';
import type { Actor } from '@/server/permissions/actor';
import type { Permission } from '@/server/domain/permissions';
import { describeDevice, generateToken, hashToken, safeCompare } from './tokens';
import type { RequestMeta } from '@/server/http/request-meta';

export interface IssuedSession {
  sessionId: string;
  /** Raw cookie value — returned once, never stored. */
  token: string;
  csrfToken: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

export async function issueSession(input: {
  userId: string;
  organizationId: string;
  provider: string;
  meta: RequestMeta;
  rotatedFromId?: string | null;
  absoluteExpiresAt?: Date;
}): Promise<IssuedSession> {
  const env = getEnv();
  const now = Date.now();

  const token = generateToken();
  const csrfToken = generateToken();

  const expiresAt = new Date(now + env.SESSION_IDLE_TIMEOUT_MINUTES * 60_000);
  // Rotation preserves the original absolute deadline: rotating must not become a way
  // to extend a session indefinitely.
  const absoluteExpiresAt =
    input.absoluteExpiresAt ?? new Date(now + env.SESSION_ABSOLUTE_TIMEOUT_MINUTES * 60_000);

  const record = await sessionRepository.create({
    userId: input.userId,
    organizationId: input.organizationId,
    tokenHash: hashToken(token),
    csrfTokenHash: hashToken(csrfToken),
    expiresAt: expiresAt < absoluteExpiresAt ? expiresAt : absoluteExpiresAt,
    absoluteExpiresAt,
    ip: input.meta.ip,
    userAgent: input.meta.userAgent,
    deviceLabel: describeDevice(input.meta.userAgent),
    provider: input.provider,
    rotatedFromId: input.rotatedFromId ?? null,
  });

  return {
    sessionId: record.id,
    token,
    csrfToken,
    expiresAt: record.expiresAt,
    absoluteExpiresAt: record.absoluteExpiresAt,
  };
}

export interface ResolvedSession {
  actor: Actor;
  sessionId: string;
  csrfTokenHash: string;
}

/** Idle expiry is only extended once every few minutes to avoid a write per request. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

/**
 * Resolves a cookie value into an Actor, or null when the session is not usable.
 *
 * Every check that could let a revoked user through is performed here, in order:
 * live session → existing user → active status → password not changed since issue.
 */
export async function resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
  if (!token || token.length < 20 || token.length > 200) return null;

  const session = await sessionRepository.findLiveByTokenHash(hashToken(token));
  if (!session) return null;

  const user = await userRepository.findById(session.userId);
  if (!user) {
    await sessionRepository.revoke(session.id, 'admin_revoked');
    return null;
  }

  // The immediate-deactivation guarantee: status is re-read on every single request.
  if (user.status !== 'active') {
    await sessionRepository.revoke(session.id, 'user_deactivated');
    return null;
  }

  // A password change invalidates sessions created before it.
  if (user.passwordUpdatedAt && user.passwordUpdatedAt > session.createdAt) {
    await sessionRepository.revoke(session.id, 'password_changed');
    return null;
  }

  const grants = await roleRepository.getActorGrants(user.id);

  const permissions = new Set<Permission>();
  for (const grant of grants) {
    for (const permission of grant.permissions) permissions.add(permission);
  }

  const actor: Actor = {
    userId: user.id,
    email: user.email,
    name: user.name,
    organizationId: user.organizationId,
    departmentId: user.departmentId,
    projectIds: user.projectIds,
    isSuperAdmin: user.isSuperAdmin,
    status: user.status,
    grants,
    permissions,
    roleKeys: grants.map((grant) => grant.roleKey),
    highestRank: grants.reduce((max, grant) => Math.max(max, grant.rank), 0),
    sessionId: session.id,
    storageQuotaBytes: user.storageQuotaBytes,
    storageUsedBytes: user.storageUsedBytes,
  };

  const sinceTouch = Date.now() - session.lastUsedAt.getTime();
  if (sinceTouch > TOUCH_INTERVAL_MS) {
    const env = getEnv();
    await sessionRepository.touch(
      session.id,
      new Date(Date.now() + env.SESSION_IDLE_TIMEOUT_MINUTES * 60_000),
    );
  }

  return { actor, sessionId: session.id, csrfTokenHash: session.csrfTokenHash };
}

export function assertCsrf(expectedHash: string, presentedToken: string | undefined): void {
  if (!presentedToken) {
    throw new UnauthenticatedError('Missing CSRF token');
  }
  if (!safeCompare(expectedHash, hashToken(presentedToken))) {
    throw new UnauthenticatedError('Invalid CSRF token');
  }
}

export async function revokeSession(sessionId: string, reason: SessionRevokeReason): Promise<void> {
  await sessionRepository.revoke(sessionId, reason);
}

export async function revokeAllSessions(
  userId: string,
  reason: SessionRevokeReason,
  exceptSessionId?: string,
): Promise<number> {
  return sessionRepository.revokeAllForUser(userId, reason, exceptSessionId ? { exceptSessionId } : {});
}

export async function listSessions(userId: string) {
  return sessionRepository.listForUser(userId);
}
