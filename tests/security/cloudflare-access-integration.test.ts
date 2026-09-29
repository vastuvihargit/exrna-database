/**
 * Cloudflare Access, end to end through the application: sign-in bridge, per-request identity
 * check, account policy and the password front door being closed.
 *
 * `tests/unit/cloudflare-access.test.ts` proves the token verifier refuses forgeries. This suite
 * proves the *integration*: that a verified identity is resolved to the right employee, that
 * the account policy (domain, provisioning, active status) still decides, that every request
 * re-checks the assertion against the session, and that nothing else — a plaintext e-mail
 * header, a session cookie on its own — is enough once Access is configured.
 *
 * Real MongoDB, real sessions, real RS256 tokens against a generated key pair served through a
 * stubbed `fetch` for the JWKS endpoint.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { seedFixture, TEST_META, TEST_PASSWORD, type Fixture } from '../helpers/fixtures';

const TEAM_DOMAIN = 'acme.cloudflareaccess.com';
const AUDIENCE = 'b'.repeat(64);
const KID = 'integration-key';

let db: TestDb;
let fixture: Fixture;
let keyPair: CryptoKeyPair;
let jwks: { keys: unknown[] };
const realFetch = globalThis.fetch;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

async function accessToken(email: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const payload = encodeJson({
    iss: `https://${TEAM_DOMAIN}`,
    aud: [AUDIENCE],
    sub: `sub-${email}`,
    email,
    exp: now + 600,
    iat: now - 5,
    nbf: now - 5,
    idp: { type: 'google' },
    ...overrides,
  });
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

async function setAccess(enabled: boolean): Promise<void> {
  if (enabled) {
    process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
    process.env.CF_ACCESS_AUD = AUDIENCE;
  } else {
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    delete process.env.CF_ACCESS_AUD;
  }
  const { resetEnvCache } = await import('@/server/config/env');
  resetEnvCache();
}

function headersWith(token?: string, extra: Record<string, string> = {}): Headers {
  const headers = new Headers(extra);
  if (token) headers.set('cf-access-jwt-assertion', token);
  return headers;
}

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] };

  db = await startTestDb();
  if (!db.available) throw new Error(`MongoDB is required: ${db.reason}`);
  fixture = await seedFixture();
}, 180_000);

afterAll(async () => {
  await setAccess(false);
  if (db?.available) await stopTestDb();
});

beforeEach(async () => {
  const { resetAccessJwksCache } = await import('@/server/auth/cloudflare-access');
  resetAccessJwksCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input) === `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
        return new Response(JSON.stringify(jwks), { status: 200 });
      }
      return realFetch(input as RequestInfo, init);
    }),
  );
  await setAccess(true);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const { resetAllRateLimits } = await import('@/server/auth/rate-limit');
  resetAllRateLimits();
  await setAccess(false);
});

describe('sign-in through Cloudflare Access', () => {
  it('resolves the employee from the verified identity and issues a session', async () => {
    const { authService } = await import('@/server/services/auth.service');
    const { resolveRequestSession } = await import('@/server/auth/access-session');
    const token = await accessToken('Alice@Company.com');

    const session = await authService.completeAccessLogin(
      { token, config: { teamDomain: TEAM_DOMAIN, audience: AUDIENCE } },
      TEST_META,
    );

    const resolved = await resolveRequestSession(session.token, headersWith(token));
    expect(resolved?.actor.userId).toBe(fixture.users.scientistA);
    expect(resolved?.actor.organizationId).toBe(fixture.organizationId);
    // Access proves identity only: roles still come from the application.
    expect(resolved?.actor.roleKeys).toContain('research_scientist');
  }, 60_000);

  it('refuses an identity with no account, under the default no-auto-provisioning policy', async () => {
    const { authService } = await import('@/server/services/auth.service');
    const token = await accessToken('stranger@company.com');

    await expect(
      authService.completeAccessLogin(
        { token, config: { teamDomain: TEAM_DOMAIN, audience: AUDIENCE } },
        TEST_META,
      ),
    ).rejects.toThrow(/not been set up/);
  }, 60_000);

  it('refuses a deactivated employee even with a valid Access token', async () => {
    const { authService } = await import('@/server/services/auth.service');
    const { UserModel } = await import('@/server/db/models');
    await UserModel.updateOne({ _id: fixture.users.scientistB }, { $set: { status: 'deactivated' } });
    try {
      const token = await accessToken('bob@company.com');
      await expect(
        authService.completeAccessLogin(
          { token, config: { teamDomain: TEAM_DOMAIN, audience: AUDIENCE } },
          TEST_META,
        ),
      ).rejects.toThrow(/not active/);
    } finally {
      await UserModel.updateOne({ _id: fixture.users.scientistB }, { $set: { status: 'active' } });
    }
  }, 60_000);

  it('refuses an address outside the company domains', async () => {
    const { authService } = await import('@/server/services/auth.service');
    const token = await accessToken('someone@gmail.com');
    await expect(
      authService.completeAccessLogin(
        { token, config: { teamDomain: TEAM_DOMAIN, audience: AUDIENCE } },
        TEST_META,
      ),
    ).rejects.toThrow(/approved company domain/);
  }, 60_000);
});

describe('every request re-checks the Access identity', () => {
  async function signedIn(email: string) {
    const { authService } = await import('@/server/services/auth.service');
    const token = await accessToken(email);
    const session = await authService.completeAccessLogin(
      { token, config: { teamDomain: TEAM_DOMAIN, audience: AUDIENCE } },
      TEST_META,
    );
    return { session, token };
  }

  it('refuses a session cookie with no Access assertion — e.g. a request that bypassed Access', async () => {
    const { resolveRequestSession } = await import('@/server/auth/access-session');
    const { session } = await signedIn('alice@company.com');
    expect(await resolveRequestSession(session.token, headersWith())).toBeNull();
  }, 60_000);

  it('never trusts the plaintext e-mail header', async () => {
    const { resolveRequestSession } = await import('@/server/auth/access-session');
    const { session } = await signedIn('alice@company.com');
    const forged = headersWith(undefined, { 'cf-access-authenticated-user-email': 'alice@company.com' });
    expect(await resolveRequestSession(session.token, forged)).toBeNull();
  }, 60_000);

  it('refuses a session whose Access identity is now somebody else', async () => {
    const { resolveRequestSession } = await import('@/server/auth/access-session');
    const { session } = await signedIn('alice@company.com');
    const bobToken = await accessToken('bob@company.com');
    expect(await resolveRequestSession(session.token, headersWith(bobToken))).toBeNull();
  }, 60_000);

  it('refuses an expired or foreign-audience assertion', async () => {
    const { resolveRequestSession } = await import('@/server/auth/access-session');
    const { session } = await signedIn('alice@company.com');
    const expired = await accessToken('alice@company.com', { exp: Math.floor(Date.now() / 1000) - 60 });
    const otherApp = await accessToken('alice@company.com', { aud: ['c'.repeat(64)] });
    expect(await resolveRequestSession(session.token, headersWith(expired))).toBeNull();
    expect(await resolveRequestSession(session.token, headersWith(otherApp))).toBeNull();
  }, 60_000);

  it('drops access the moment the employee is deactivated, Access token notwithstanding', async () => {
    const { resolveRequestSession } = await import('@/server/auth/access-session');
    const { UserModel } = await import('@/server/db/models');
    const { session, token } = await signedIn('bob@company.com');
    await UserModel.updateOne({ _id: fixture.users.scientistB }, { $set: { status: 'deactivated' } });
    try {
      expect(await resolveRequestSession(session.token, headersWith(token))).toBeNull();
    } finally {
      await UserModel.updateOne({ _id: fixture.users.scientistB }, { $set: { status: 'active' } });
    }
  }, 60_000);

  it('accepts the cookie form of the assertion, as a same-origin fetch carries it', async () => {
    const { resolveRequestSession } = await import('@/server/auth/access-session');
    const { session, token } = await signedIn('alice@company.com');
    const headers = new Headers({ cookie: `other=1; CF_Authorization=${token}` });
    expect((await resolveRequestSession(session.token, headers))?.actor.email).toBe('alice@company.com');
  }, 60_000);
});

describe('the password front door is closed while Access is configured', () => {
  it('refuses password sign-in and password reset', async () => {
    const { authService } = await import('@/server/services/auth.service');
    await expect(
      authService.loginWithPassword({ email: 'alice@company.com', password: TEST_PASSWORD }, TEST_META),
    ).rejects.toThrow(/single sign-on/);
    await expect(authService.requestPasswordReset('alice@company.com', TEST_META)).rejects.toThrow(
      /single sign-on/,
    );
  }, 60_000);

  it('works exactly as before when Access is not configured (local development)', async () => {
    await setAccess(false);
    const { authService } = await import('@/server/services/auth.service');
    const { resolveRequestSession } = await import('@/server/auth/access-session');
    const session = await authService.loginWithPassword(
      { email: 'alice@company.com', password: TEST_PASSWORD },
      TEST_META,
    );
    expect((await resolveRequestSession(session.token, headersWith()))?.actor.email).toBe(
      'alice@company.com',
    );
  }, 60_000);
});

describe('GET /api/auth/access', () => {
  async function callBridge(headers: Headers, next = '/files'): Promise<Response> {
    const { GET } = await import('@/app/api/auth/access/route');
    const request = new NextRequest(`http://localhost:3000/api/auth/access?next=${encodeURIComponent(next)}`, {
      headers,
    });
    return GET(request, undefined);
  }

  it('signs in, sets the session cookie and redirects to the requested path', async () => {
    const response = await callBridge(headersWith(await accessToken('alice@company.com')));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/files');
    expect(response.headers.get('set-cookie')).toMatch(/bd_session=/);
  }, 60_000);

  it('never redirects off-site', async () => {
    const response = await callBridge(
      headersWith(await accessToken('alice@company.com')),
      '//evil.example/steal',
    );
    expect(response.headers.get('location')).toBe('http://localhost:3000/home');
  }, 60_000);

  it('sends a missing, invalid or unprovisioned identity to the denial page without a session', async () => {
    const missing = await callBridge(headersWith());
    expect(missing.headers.get('location')).toContain('/access-denied?reason=access_missing');

    const invalid = await callBridge(headersWith('not.a.jwt'));
    expect(invalid.headers.get('location')).toContain('/access-denied?reason=access_invalid');

    const stranger = await callBridge(headersWith(await accessToken('stranger@company.com')));
    expect(stranger.headers.get('location')).toContain('/access-denied?reason=not_provisioned');
    expect(stranger.headers.get('set-cookie') ?? '').not.toMatch(/bd_session=[^;]/);
  }, 60_000);

  it('does not exist when Access is not configured', async () => {
    await setAccess(false);
    const response = await callBridge(headersWith(await accessToken('alice@company.com')));
    expect(response.status).toBe(404);
  }, 60_000);
});
