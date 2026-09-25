/**
 * Authentication service.
 *
 * Two rules shape every function here:
 *
 *  1. **The response must not distinguish failure modes.** Unknown address, wrong
 *     password, non-company domain and not-yet-provisioned all return the same message
 *     and burn the same CPU. Anything else is an account-enumeration oracle.
 *  2. **Every attempt is recorded** — login history for the admin view, audit log for
 *     the permanent record.
 */
import { getEnv } from '@/server/config/env';
import {
  ForbiddenError,
  UnauthenticatedError,
  ValidationError,
} from '@/server/errors/app-error';
import * as userRepository from '@/server/repositories/user.repository';
import * as organizationRepository from '@/server/repositories/organization.repository';
import * as loginHistory from '@/server/repositories/login-history.repository';
import * as sessionRepository from '@/server/repositories/session.repository';
import { verifyAccessJwt, type AccessConfig } from '@/server/auth/cloudflare-access';
import { PasswordResetTokenModel } from '@/server/db/models';
import { connectToDatabase } from '@/server/db/connection';
import { auditService } from '@/server/audit/audit.service';
import { getLogger } from '@/server/logging/logger';
import type { RequestMeta } from '@/server/http/request-meta';
import { normalizeCompanyEmail, parseEmail } from '@/server/auth/email-domain';
import {
  burnPasswordVerification,
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
} from '@/server/auth/password';
import { enforce, reset, RATE_LIMITS } from '@/server/auth/rate-limit';
import { generateToken, hashToken } from '@/server/auth/tokens';
import { issueSession, revokeAllSessions, type IssuedSession } from '@/server/auth/session.service';
import { Types } from 'mongoose';
import { isAccessEnforced } from '@/server/auth/access-session';

const FAILED_LOGIN_LOCK_THRESHOLD = 5;
const GENERIC_LOGIN_ERROR = 'Incorrect email address or password';
const PASSWORD_RESET_TTL_MS = 30 * 60_000;

export interface LoginInput {
  email: string;
  password: string;
}

/**
 * Password sign-in.
 *
 * Note the ordering: rate limits first (cheap), then domain check, then the account
 * lookup. Regardless of which check fails, the caller sees one message.
 */
/** Refuses password flows when Cloudflare Access is the configured sign-in method. */
function assertPasswordAuthAvailable(): void {
  if (isAccessEnforced()) {
    throw new ForbiddenError(
      'Sign-in is handled by your company single sign-on. Password sign-in is not available here.',
    );
  }
}

export async function loginWithPassword(input: LoginInput, meta: RequestMeta): Promise<IssuedSession> {
  // With Cloudflare Access in front, Access is the only way in. A password path left open
  // beside it would be a second front door that bypasses the company identity provider.
  assertPasswordAuthAvailable();
  const env = getEnv();

  enforce(`login:ip:${meta.ip}`, RATE_LIMITS.login);

  const parsed = parseEmail(input.email);
  const emailForLog = parsed?.normalized ?? String(input.email).slice(0, 320).toLowerCase();

  enforce(`login:email:${emailForLog}`, RATE_LIMITS.loginPerEmail);

  const allowedDomains = await organizationRepository.getSignInDomains(env.COMPANY_EMAIL_DOMAINS);
  const email = normalizeCompanyEmail(input.email, allowedDomains);

  if (!email) {
    // Personal or malformed address: burn the same work, record, and fail identically.
    await burnPasswordVerification(input.password);
    await loginHistory.record({
      email: emailForLog,
      outcome: 'domain_rejected',
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: 'Address is not on an approved company domain',
    });
    await auditService.recordAnonymous(meta, {
      action: 'auth.login_failed',
      entityType: 'user',
      entityLabel: emailForLog,
      outcome: 'denied',
      severity: 'notice',
      newValue: { reason: 'domain_rejected' },
    });
    throw new UnauthenticatedError(GENERIC_LOGIN_ERROR);
  }

  const found = await userRepository.findByEmailWithSecrets(email);

  if (!found) {
    await burnPasswordVerification(input.password);
    await loginHistory.record({ email, outcome: 'unknown_user', ip: meta.ip, userAgent: meta.userAgent });
    await auditService.recordAnonymous(meta, {
      action: 'auth.login_failed',
      entityType: 'user',
      entityLabel: email,
      outcome: 'denied',
      severity: 'notice',
      newValue: { reason: 'unknown_user' },
    });
    throw new UnauthenticatedError(GENERIC_LOGIN_ERROR);
  }

  const { user, passwordHash } = found;

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await burnPasswordVerification(input.password);
    await loginHistory.record({
      userId: user.id,
      email,
      outcome: 'locked',
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    throw new UnauthenticatedError(GENERIC_LOGIN_ERROR);
  }

  if (user.status !== 'active') {
    await burnPasswordVerification(input.password);
    await loginHistory.record({
      userId: user.id,
      email,
      outcome: user.status === 'invited' ? 'not_provisioned' : 'deactivated',
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await auditService.recordAnonymous(meta, {
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: user.id,
      entityLabel: email,
      outcome: 'denied',
      severity: 'warning',
      newValue: { reason: user.status },
    });
    throw new UnauthenticatedError(GENERIC_LOGIN_ERROR);
  }

  if (!passwordHash) {
    // OAuth-only account: do not reveal that password sign-in is unavailable for it.
    await burnPasswordVerification(input.password);
    await loginHistory.record({
      userId: user.id,
      email,
      outcome: 'bad_password',
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: 'No password credential on this account',
    });
    throw new UnauthenticatedError(GENERIC_LOGIN_ERROR);
  }

  const valid = await verifyPassword(passwordHash, input.password);
  if (!valid) {
    const failures = await userRepository.recordFailedLogin(user.id, FAILED_LOGIN_LOCK_THRESHOLD);
    await loginHistory.record({
      userId: user.id,
      email,
      outcome: 'bad_password',
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: `Failure ${failures}`,
    });
    await auditService.recordAnonymous(meta, {
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: user.id,
      entityLabel: email,
      outcome: 'denied',
      severity: failures >= FAILED_LOGIN_LOCK_THRESHOLD ? 'warning' : 'notice',
      newValue: { reason: 'bad_password', failures },
    });
    throw new UnauthenticatedError(GENERIC_LOGIN_ERROR);
  }

  const session = await issueSession({
    userId: user.id,
    organizationId: user.organizationId,
    provider: 'password',
    meta,
  });

  await userRepository.recordSuccessfulLogin(user.id);
  reset(`login:email:${email}`);

  await loginHistory.record({
    userId: user.id,
    email,
    outcome: 'success',
    ip: meta.ip,
    userAgent: meta.userAgent,
    sessionId: session.sessionId,
  });
  await auditService.recordAnonymous(meta, {
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    entityLabel: email,
    organizationId: user.organizationId,
    actorEmail: email,
    newValue: { provider: 'password' },
  });

  return session;
}

/**
 * Completes an OAuth sign-in for an already-verified company address.
 *
 * The caller (the OAuth callback) has verified the ID token signature, issuer,
 * audience, nonce and `email_verified`. This function owns the account-status policy.
 */
export async function completeOAuthLogin(
  input: { email: string; name?: string; providerAccountId: string; provider: 'google' | 'microsoft' },
  meta: RequestMeta,
): Promise<IssuedSession> {
  const env = getEnv();
  const allowedDomains = await organizationRepository.getSignInDomains(env.COMPANY_EMAIL_DOMAINS);
  const email = normalizeCompanyEmail(input.email, allowedDomains);

  if (!email) {
    await loginHistory.record({
      email: String(input.email).toLowerCase().slice(0, 320),
      outcome: 'domain_rejected',
      provider: input.provider,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    throw new ForbiddenError('This account is not on an approved company domain');
  }

  let user = await userRepository.findByEmail(email);

  if (!user) {
    const organization = await organizationRepository.getPrimary();
    const autoProvision = organization?.settings.allowAutoProvisioning ?? env.ALLOW_AUTO_PROVISIONING;

    // Owning a company address is sign-in *eligibility*, not access. With
    // auto-provisioning off (the default), an administrator must create the account.
    if (!autoProvision || !organization) {
      await loginHistory.record({
        email,
        outcome: 'not_provisioned',
        provider: input.provider,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await auditService.recordAnonymous(meta, {
        action: 'auth.login_failed',
        entityType: 'user',
        entityLabel: email,
        outcome: 'denied',
        severity: 'notice',
        newValue: { reason: 'not_provisioned', provider: input.provider },
      });
      throw new ForbiddenError(
        'Your account has not been set up yet. Contact your administrator for access.',
      );
    }

    user = await userRepository.create({
      organizationId: organization.id,
      email,
      emailDomain: email.split('@')[1]!,
      name: input.name?.trim() || email.split('@')[0]!,
      status: 'active',
      storageQuotaBytes: organization.settings.defaultUserQuotaBytes || env.defaultUserQuotaBytes,
      authProvider: input.provider,
    });

    await auditService.recordAnonymous(meta, {
      action: 'user.created',
      entityType: 'user',
      entityId: user.id,
      entityLabel: email,
      organizationId: organization.id,
      newValue: { autoProvisioned: true, provider: input.provider },
      severity: 'notice',
    });
  }

  if (user.status !== 'active') {
    await loginHistory.record({
      userId: user.id,
      email,
      outcome: user.status === 'invited' ? 'not_provisioned' : 'deactivated',
      provider: input.provider,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    throw new ForbiddenError('Your account is not active. Contact your administrator.');
  }

  await userRepository.linkAuthProvider(user.id, input.provider, input.providerAccountId);

  const session = await issueSession({
    userId: user.id,
    organizationId: user.organizationId,
    provider: input.provider,
    meta,
  });

  await userRepository.recordSuccessfulLogin(user.id);
  await loginHistory.record({
    userId: user.id,
    email,
    outcome: 'success',
    provider: input.provider,
    ip: meta.ip,
    userAgent: meta.userAgent,
    sessionId: session.sessionId,
  });
  await auditService.recordAnonymous(meta, {
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    entityLabel: email,
    organizationId: user.organizationId,
    actorEmail: email,
    newValue: { provider: input.provider },
  });

  return session;
}

/**
 * Turns a verified Cloudflare Access assertion into an application session.
 *
 * ── Why this delegates rather than reimplements ─────────────────────────────────────────
 *
 * Everything after "who is this person" is identical to the OAuth path: the company-domain
 * check, the auto-provisioning policy, the active-user enforcement, the login-history row, the
 * audit record and the session issue. Writing that again here would create a second copy of the
 * account-status policy, and the failure mode of two copies is that one of them keeps letting a
 * deactivated employee in after the other stopped.
 *
 * So this function owns exactly one thing — establishing the email address from a signature —
 * and hands the rest to `completeOAuthLogin`.
 *
 * ── Access proves identity, not authorization ───────────────────────────────────────────
 *
 * A valid assertion says Cloudflare authenticated this person against the configured IdP. It
 * says nothing about whether they have an account here, whether it is active, or what they may
 * do. All three remain the application's decision, which is why a token for an unknown or
 * suspended address still fails below.
 */
export async function completeAccessLogin(
  input: { token: string; config: AccessConfig },
  meta: RequestMeta,
): Promise<IssuedSession> {
  const identity = await verifyAccessJwt(input.token, input.config);

  return completeOAuthLogin(
    {
      email: identity.email,
      // Access's `sub` is stable per user per application, which is what the provider-account
      // link wants. Recorded as `google` because that is the IdP behind Access here; the
      // provider enum has no `access` member and adding one would change the meaning of every
      // historic row.
      providerAccountId: identity.subject,
      provider: 'google',
    },
    meta,
  );
}

export async function logout(sessionId: string, userId: string, meta: RequestMeta): Promise<void> {
  await sessionRepository.revoke(sessionId, 'logout');
  await auditService.recordAnonymous(meta, {
    action: 'auth.logout',
    entityType: 'session',
    entityId: sessionId,
    actorEmail: null,
    newValue: { userId },
  });
}

export async function logoutEverywhere(userId: string, meta: RequestMeta): Promise<number> {
  const revoked = await revokeAllSessions(userId, 'logout_all');
  await auditService.recordAnonymous(meta, {
    action: 'auth.logout_all',
    entityType: 'user',
    entityId: userId,
    newValue: { sessionsRevoked: revoked },
    severity: 'notice',
  });
  return revoked;
}

/**
 * Starts a password reset.
 *
 * Always resolves successfully, whatever the address: telling an anonymous caller
 * whether an address exists is the same leak as a distinguishable login error.
 * Returns the token only so the caller can deliver it by email; it is never in a response body.
 */
export async function requestPasswordReset(
  emailInput: string,
  meta: RequestMeta,
): Promise<{ token: string; email: string; userId: string } | null> {
  // With Cloudflare Access in front, Access is the only way in. A password path left open
  // beside it would be a second front door that bypasses the company identity provider.
  assertPasswordAuthAvailable();
  const env = getEnv();

  enforce(`pwreset:ip:${meta.ip}`, RATE_LIMITS.passwordResetPerIp);

  const parsed = parseEmail(emailInput);
  if (parsed) enforce(`pwreset:email:${parsed.normalized}`, RATE_LIMITS.passwordResetPerEmail);

  const allowedDomains = await organizationRepository.getSignInDomains(env.COMPANY_EMAIL_DOMAINS);
  const email = normalizeCompanyEmail(emailInput, allowedDomains);
  if (!email) return null;

  const user = await userRepository.findByEmail(email);
  if (!user || user.status !== 'active') return null;

  await connectToDatabase();
  const token = generateToken();
  await PasswordResetTokenModel.create({
    userId: new Types.ObjectId(user.id),
    tokenHash: await hashToken(token),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    requestedIp: meta.ip,
  });

  await auditService.recordAnonymous(meta, {
    action: 'auth.password_reset_requested',
    entityType: 'user',
    entityId: user.id,
    entityLabel: email,
    organizationId: user.organizationId,
    severity: 'notice',
  });

  getLogger().info({ userId: user.id }, 'Password reset requested');
  return { token, email, userId: user.id };
}

/**
 * Completes a reset. The token is single-use, and success revokes every existing
 * session — a reset is exactly the moment you want other devices signed out.
 */
export async function completePasswordReset(
  input: { token: string; password: string },
  meta: RequestMeta,
): Promise<void> {
  // With Cloudflare Access in front, Access is the only way in. A password path left open
  // beside it would be a second front door that bypasses the company identity provider.
  assertPasswordAuthAvailable();
  await connectToDatabase();

  const record = await PasswordResetTokenModel.findOne({
    tokenHash: await hashToken(input.token),
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).exec();

  if (!record) {
    throw new ValidationError('This reset link is invalid or has expired');
  }

  const user = await userRepository.findById(String(record.userId));
  if (!user || user.status !== 'active') {
    throw new ValidationError('This reset link is invalid or has expired');
  }

  const policy = checkPasswordPolicy(input.password, { email: user.email, name: user.name });
  if (!policy.ok) {
    throw new ValidationError('Password does not meet the policy', policy.problems);
  }

  await userRepository.setPasswordHash(user.id, await hashPassword(input.password));
  await PasswordResetTokenModel.updateOne({ _id: record._id }, { $set: { usedAt: new Date() } }).exec();
  await revokeAllSessions(user.id, 'password_changed');

  await auditService.recordAnonymous(meta, {
    action: 'auth.password_reset_completed',
    entityType: 'user',
    entityId: user.id,
    entityLabel: user.email,
    organizationId: user.organizationId,
    severity: 'warning',
  });
}

/**
 * Self-service password change. Requires the current password, even in an active session.
 *
 * Every existing session is revoked — including the one making the request — and a
 * fresh session is issued for this device. Keeping the old session alive would
 * contradict the invariant in `resolveSession` that a session created before the
 * password changed is not trustworthy; re-issuing keeps the user signed in here while
 * that invariant stays absolute.
 */
export async function changePassword(
  input: { userId: string; currentPassword: string; newPassword: string; sessionId: string },
  meta: RequestMeta,
): Promise<IssuedSession> {
  const user = await userRepository.findById(input.userId);
  if (!user) throw new UnauthenticatedError();

  const found = await userRepository.findByEmailWithSecrets(user.email);
  if (!found?.passwordHash) {
    throw new ValidationError('This account does not use password sign-in');
  }

  const valid = await verifyPassword(found.passwordHash, input.currentPassword);
  if (!valid) throw new ValidationError('Current password is incorrect');

  const policy = checkPasswordPolicy(input.newPassword, { email: user.email, name: user.name });
  if (!policy.ok) throw new ValidationError('Password does not meet the policy', policy.problems);

  await userRepository.setPasswordHash(user.id, await hashPassword(input.newPassword));
  await revokeAllSessions(user.id, 'password_changed');

  const session = await issueSession({
    userId: user.id,
    organizationId: user.organizationId,
    provider: 'password',
    meta,
  });

  await auditService.recordAnonymous(meta, {
    action: 'auth.password_changed',
    entityType: 'user',
    entityId: user.id,
    entityLabel: user.email,
    organizationId: user.organizationId,
    actorEmail: user.email,
    severity: 'warning',
  });

  return session;
}

export const authService = {
  loginWithPassword,
  completeOAuthLogin,
  completeAccessLogin,
  logout,
  logoutEverywhere,
  requestPasswordReset,
  completePasswordReset,
  changePassword,
};
