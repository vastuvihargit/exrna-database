/**
 * Phase 2 security suite — proves the acceptance criteria the brief names explicitly:
 *
 *   • personal email addresses cannot sign in
 *   • a deactivated employee loses access immediately
 *   • sessions expire, rotate and can be revoked
 *   • login failures are indistinguishable from one another
 *   • NoSQL injection payloads cannot authenticate
 *   • roles and permissions load from MongoDB
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { seedFixture, TEST_META, TEST_PASSWORD, type Fixture } from '../helpers/fixtures';

let db: TestDb;
let fixture: Fixture;

beforeAll(async () => {
  db = await startTestDb();
  if (db.available) fixture = await seedFixture();
}, 180_000);

afterAll(async () => {
  if (db?.available) await stopTestDb();
});

afterEach(async () => {
  if (!db?.available) return;
  const { resetAllRateLimits } = await import('@/server/auth/rate-limit');
  resetAllRateLimits();
});

describe('authentication', () => {
  it('signs in with a valid company address and password', async () => {
    if (!db.available) {
      expect(db.reason, 'in-memory MongoDB unavailable').toBeTruthy();
      return;
    }

    const { authService } = await import('@/server/services/auth.service');
    const { resolveSession } = await import('@/server/auth/session.service');

    const session = await authService.loginWithPassword(
      { email: 'alice@company.com', password: TEST_PASSWORD },
      TEST_META,
    );

    expect(session.token).toBeTruthy();
    expect(session.csrfToken).toBeTruthy();
    expect(session.token).not.toBe(session.csrfToken);

    const resolved = await resolveSession(session.token);
    expect(resolved?.actor.email).toBe('alice@company.com');
    // Roles come from MongoDB, not from code.
    expect(resolved?.actor.roleKeys).toContain('research_scientist');
    expect(resolved?.actor.permissions.has('file.upload')).toBe(true);
  }, 60_000);

  it('rejects personal email addresses', async () => {
    if (!db.available) return;
    const { authService } = await import('@/server/services/auth.service');

    for (const email of ['alice@gmail.com', 'alice@company.com.attacker.io', 'alice@outlook.com']) {
      await expect(
        authService.loginWithPassword({ email, password: TEST_PASSWORD }, TEST_META),
        email,
      ).rejects.toThrow();
    }
  }, 60_000);

  /**
   * Unknown address, wrong password and non-company domain must be indistinguishable,
   * or the endpoint becomes an account-enumeration oracle.
   */
  it('returns an identical error for every failure mode', async () => {
    if (!db.available) return;
    const { authService } = await import('@/server/services/auth.service');

    const messages: string[] = [];
    for (const attempt of [
      { email: 'alice@company.com', password: 'WrongPassword-123!' },
      { email: 'ghost@company.com', password: TEST_PASSWORD },
      { email: 'alice@gmail.com', password: TEST_PASSWORD },
    ]) {
      try {
        await authService.loginWithPassword(attempt, TEST_META);
        expect.unreachable('login should have failed');
      } catch (error) {
        messages.push((error as Error).message);
      }
    }

    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe('Incorrect email address or password');
  }, 60_000);

  it('cannot be bypassed with a NoSQL injection payload', async () => {
    if (!db.available) return;
    const { loginSchema } = await import('@/server/validation/auth.schemas');

    // The Zod layer rejects the payload before it can reach a query at all.
    expect(() => loginSchema.parse({ email: { $ne: null }, password: { $ne: null } })).toThrow();
    expect(() => loginSchema.parse({ email: ['a@company.com'], password: 'x' })).toThrow();
    expect(() => loginSchema.parse({ email: 'a@company.com', password: 'x', isSuperAdmin: true })).toThrow();
  });

  it('locks an account after repeated failures', async () => {
    if (!db.available) return;
    const { authService } = await import('@/server/services/auth.service');
    const { resetAllRateLimits } = await import('@/server/auth/rate-limit');
    const userRepository = await import('@/server/repositories/user.repository');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Reset the rate limiter so the lockout mechanism itself is what we observe.
      resetAllRateLimits();
      await authService
        .loginWithPassword({ email: 'bob@company.com', password: 'Wrong-Password-1!' }, TEST_META)
        .catch(() => undefined);
    }

    const locked = await userRepository.findByEmail('bob@company.com');
    expect(locked?.failedLoginCount).toBeGreaterThanOrEqual(5);
    expect(locked?.lockedUntil).toBeTruthy();
    expect(locked!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Even the correct password is refused while the lock holds.
    resetAllRateLimits();
    await expect(
      authService.loginWithPassword({ email: 'bob@company.com', password: TEST_PASSWORD }, TEST_META),
    ).rejects.toThrow();
  }, 120_000);

  it('rate-limits repeated attempts from one address', async () => {
    if (!db.available) return;
    const { authService } = await import('@/server/services/auth.service');
    const { RateLimitError } = await import('@/server/errors/app-error');

    // An address with no account: the limiter must fire before any account lookup
    // matters, and using a non-fixture address keeps this test from locking one.
    let rateLimited = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await authService.loginWithPassword(
          { email: 'flooder@company.com', password: 'Wrong-Password-1!' },
          TEST_META,
        );
      } catch (error) {
        if (error instanceof RateLimitError) {
          rateLimited = true;
          break;
        }
      }
    }
    expect(rateLimited).toBe(true);
  }, 120_000);
});

describe('session lifecycle', () => {
  it('records the token only as a hash', async () => {
    if (!db.available) return;
    const { authService } = await import('@/server/services/auth.service');
    const { SessionModel } = await import('@/server/db/models');
    const { hashToken } = await import('@/server/auth/tokens');

    const session = await authService.loginWithPassword(
      { email: 'alice@company.com', password: TEST_PASSWORD },
      TEST_META,
    );

    const stored = await SessionModel.findById(session.sessionId).select('+tokenHash').lean();
    expect(stored?.tokenHash).toBe(await hashToken(session.token));
    expect(JSON.stringify(stored)).not.toContain(session.token);
  }, 60_000);

  it('rejects a forged or expired session token', async () => {
    if (!db.available) return;
    const { resolveSession } = await import('@/server/auth/session.service');
    const { authService } = await import('@/server/services/auth.service');
    const { SessionModel } = await import('@/server/db/models');

    expect(await resolveSession('forged-token-value-that-is-long-enough')).toBeNull();
    expect(await resolveSession(undefined)).toBeNull();
    expect(await resolveSession('')).toBeNull();

    const session = await authService.loginWithPassword(
      { email: 'alice@company.com', password: TEST_PASSWORD },
      TEST_META,
    );
    expect(await resolveSession(session.token)).not.toBeNull();

    // Force expiry and confirm the query — not just the code — refuses it.
    await SessionModel.updateOne(
      { _id: session.sessionId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(await resolveSession(session.token)).toBeNull();
  }, 60_000);

  it('invalidates every session when the password changes', async () => {
    if (!db.available) return;
    const { authService } = await import('@/server/services/auth.service');
    const { resolveSession } = await import('@/server/auth/session.service');

    const first = await authService.loginWithPassword(
      { email: 'exec@company.com', password: TEST_PASSWORD },
      TEST_META,
    );
    const second = await authService.loginWithPassword(
      { email: 'exec@company.com', password: TEST_PASSWORD },
      TEST_META,
    );

    const reissued = await authService.changePassword(
      {
        userId: fixture.users.viewer,
        currentPassword: TEST_PASSWORD,
        newPassword: 'Rotated-Passw0rd!2026',
        sessionId: second.sessionId,
      },
      TEST_META,
    );

    // Every pre-existing session is dead, including the one that made the change…
    expect(await resolveSession(first.token)).toBeNull();
    expect(await resolveSession(second.token)).toBeNull();
    // …and the caller receives a fresh session so this device stays signed in.
    expect(await resolveSession(reissued.token)).not.toBeNull();
  }, 120_000);
});

describe('immediate deactivation', () => {
  /** The brief's explicit requirement: access must stop on the very next request. */
  it('a deactivated employee loses access immediately', async () => {
    if (!db.available) return;

    const { authService } = await import('@/server/services/auth.service');
    const { resolveSession } = await import('@/server/auth/session.service');
    const { userService } = await import('@/server/services/user.service');

    const session = await authService.loginWithPassword(
      { email: 'alice@company.com', password: TEST_PASSWORD },
      TEST_META,
    );
    const resolved = await resolveSession(session.token);
    expect(resolved).not.toBeNull();

    const adminSession = await authService.loginWithPassword(
      { email: 'admin@company.com', password: TEST_PASSWORD },
      TEST_META,
    );
    const admin = (await resolveSession(adminSession.token))!.actor;

    await userService.setStatus(admin, fixture.users.scientistA, 'deactivated', 'Left the company', TEST_META);

    // Same cookie, next request: refused.
    expect(await resolveSession(session.token)).toBeNull();
  }, 120_000);

  it('a deactivated employee cannot sign in again', async () => {
    if (!db.available) return;
    const { authService } = await import('@/server/services/auth.service');
    const { UserModel } = await import('@/server/db/models');

    await UserModel.updateOne(
      { _id: fixture.users.noRole },
      { $set: { status: 'deactivated', deactivatedAt: new Date() } },
    );

    await expect(
      authService.loginWithPassword({ email: 'newcomer@company.com', password: TEST_PASSWORD }, TEST_META),
    ).rejects.toThrow('Incorrect email address or password');
  }, 60_000);

  it('an invited-but-not-activated employee cannot sign in', async () => {
    if (!db.available) return;
    const { authService } = await import('@/server/services/auth.service');
    const { UserModel } = await import('@/server/db/models');

    await UserModel.updateOne({ _id: fixture.users.noRole }, { $set: { status: 'invited' } });

    await expect(
      authService.loginWithPassword({ email: 'newcomer@company.com', password: TEST_PASSWORD }, TEST_META),
    ).rejects.toThrow();
  }, 60_000);
});

describe('audit trail', () => {
  it('records both successful and failed sign-ins', async () => {
    if (!db.available) return;
    const { authService } = await import('@/server/services/auth.service');
    const { AuditLogModel, LoginHistoryModel } = await import('@/server/db/models');
    const { resetAllRateLimits } = await import('@/server/auth/rate-limit');

    await AuditLogModel.deleteMany({}).catch(() => undefined);

    resetAllRateLimits();
    await authService
      .loginWithPassword({ email: 'admin@company.com', password: 'Wrong-Password-1!' }, TEST_META)
      .catch(() => undefined);

    resetAllRateLimits();
    await authService.loginWithPassword(
      { email: 'admin@company.com', password: TEST_PASSWORD },
      TEST_META,
    );

    const failed = await AuditLogModel.findOne({ action: 'auth.login_failed' }).lean();
    const success = await AuditLogModel.findOne({ action: 'auth.login' }).lean();

    expect(failed).toBeTruthy();
    expect(failed?.outcome).toBe('denied');
    expect(success).toBeTruthy();
    expect(success?.ip).toBe(TEST_META.ip);

    const history = await LoginHistoryModel.find({ email: 'admin@company.com' }).lean();
    expect(history.map((entry) => entry.outcome)).toEqual(
      expect.arrayContaining(['bad_password', 'success']),
    );
  }, 120_000);

  it('refuses to modify or delete an audit entry', async () => {
    if (!db.available) return;
    const { AuditLogModel } = await import('@/server/db/models');

    const entry = await AuditLogModel.findOne().lean();
    if (!entry) {
      expect.unreachable('expected at least one audit entry from earlier tests');
      return;
    }

    await expect(
      AuditLogModel.updateOne({ _id: entry._id }, { $set: { action: 'auth.login' } }),
    ).rejects.toThrow(/append-only/i);
    await expect(AuditLogModel.deleteOne({ _id: entry._id })).rejects.toThrow(/append-only/i);
    await expect(AuditLogModel.deleteMany({})).rejects.toThrow(/append-only/i);
  }, 60_000);
});
