/**
 * Google Workspace sign-in (`AUTH_PROVIDER=google_oauth`) end to end, on D1.
 *
 * Drives the real routes — `GET /api/auth/google`, then `GET /api/auth/google/callback` — with
 * the cookies the first one set, so state, PKCE and nonce are exercised as a browser would. The
 * ID tokens are real RS256 JWTs signed by a generated key; only Google's two endpoints (token
 * exchange and JWKS) are stubbed. Every repository — users, roles, sessions, login history,
 * audit — is the D1 implementation, as on the Worker.
 *
 * What it proves: identity comes only from a verified ID token; the application's account policy
 * (domain, provisioning, active status) still decides; the session issued is the ordinary one,
 * with the user's roles; logout ends it; and no redirect can be steered off APP_URL.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { NextRequest } from 'next/server';

import { startTestD1, stopTestD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import {
  DATA_SOURCE_MODULES,
  clearDataSourceOverrides,
  setDataSourceOverride,
} from '@/server/repositories/data-source';

const APP_URL = 'https://staging.exrna.test';
const CLIENT_ID = 'staging-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'staging-client-secret';
const KID = 'google-test-key';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';

const ORG = '65f000000000000000000001';
const ALICE = '65f000000000000000000011'; // active, holds a role
const BOB = '65f000000000000000000012'; // deactivated
const ROLE = '65f000000000000000000021';
const ISO = '2026-01-01T00:00:00.000Z';

const ENV_OVERRIDES: Record<string, string> = {
  AUTH_PROVIDER: 'google_oauth',
  APP_URL,
  GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  GOOGLE_WORKSPACE_DOMAIN: 'exrna.com',
  COMPANY_EMAIL_DOMAINS: 'exrna.com',
  ALLOW_AUTO_PROVISIONING: 'false',
};
const savedEnv: Record<string, string | undefined> = {};

let d1: D1Database;
let keyPair: CryptoKeyPair;
let foreignKeyPair: CryptoKeyPair;
let jwks: { keys: unknown[] };
const realFetch = globalThis.fetch;

/** What the stubbed token endpoint returns next, and what it was sent. */
let nextIdToken: string | null = null;
let tokenRequests: URLSearchParams[] = [];

/* ------------------------------------------------------------------ tokens */

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

async function idToken(
  claims: Record<string, unknown>,
  signer: CryptoKeyPair = keyPair,
): Promise<string> {
  const header = encodeJson({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const payload = encodeJson(claims);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signer.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

function googleClaims(email: string, nonce: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: `google-${email}`,
    email,
    email_verified: true,
    hd: 'exrna.com',
    nonce,
    iat: now - 5,
    exp: now + 600,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ the browser */

interface Started {
  location: URL;
  cookies: Record<string, string>;
}

function setCookies(response: Response): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const index = pair!.indexOf('=');
    cookies.set(pair!.slice(0, index), line);
  }
  return cookies;
}

const cookieValue = (line: string | undefined) => line?.split(';')[0]!.split('=').slice(1).join('=') ?? '';

async function startSignIn(): Promise<Started> {
  const { GET } = await import('@/app/api/auth/google/route');
  const response = await GET(new NextRequest(`${APP_URL}/api/auth/google`), undefined);
  expect(response.status).toBe(307);
  const cookies = Object.fromEntries(
    [...setCookies(response)].map(([name, line]) => [name, cookieValue(line)]),
  );
  return { location: new URL(response.headers.get('location')!), cookies };
}

async function callback(
  started: Started,
  options: { state?: string; query?: string; host?: string; cookies?: Record<string, string> } = {},
): Promise<Response> {
  const { GET } = await import('@/app/api/auth/google/callback/route');
  const state = options.state ?? started.cookies.bd_oauth_state!;
  const cookies = options.cookies ?? started.cookies;
  const url = `${options.host ?? APP_URL}/api/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}${options.query ?? ''}`;
  return GET(
    new NextRequest(url, {
      headers: {
        cookie: Object.entries(cookies)
          .map(([name, value]) => `${name}=${value}`)
          .join('; '),
      },
    }),
    undefined,
  );
}

/** One complete sign-in: start, Google returns `claims` (nonce filled in), callback. */
async function signIn(
  email: string,
  overrides: Record<string, unknown> = {},
  signer?: CryptoKeyPair,
): Promise<Response> {
  const started = await startSignIn();
  nextIdToken = await idToken(googleClaims(email, started.cookies.bd_oauth_nonce!, overrides), signer);
  return callback(started);
}

function redirectOf(response: Response): URL {
  expect(response.status).toBe(307);
  return new URL(response.headers.get('location')!);
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await d1.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

/* ------------------------------------------------------------------ harness */

async function seed(): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO organizations (id, name, slug, email_domains, settings, storage_used_bytes, file_count, is_active, created_at, updated_at)
       VALUES (?, 'exRNA', 'exrna', '["exrna.com","exrna-partner.com"]', '{}', 0, 0, 1, ?, ?)`,
    )
    .bind(ORG, ISO, ISO)
    .run();
  for (const [id, email, status] of [
    [ALICE, 'alice@exrna.com', 'active'],
    [BOB, 'bob@exrna.com', 'deactivated'],
  ] as const) {
    await d1
      .prepare(
        `INSERT INTO users (id, organization_id, email, email_domain, name, mfa, preferences, status,
           is_super_admin, storage_quota_bytes, storage_used_bytes, must_change_password,
           failed_login_count, created_at, updated_at)
         VALUES (?, ?, ?, 'exrna.com', ?, '{"enabled":false}', '{}', ?, 0, 1, 0, 0, 0, ?, ?)`,
      )
      .bind(id, ORG, email, email.split('@')[0], status, ISO, ISO)
      .run();
  }
  await d1
    .prepare(
      `INSERT INTO roles (id, organization_id, key, name, description, rank, max_confidentiality,
         company_wide_read, is_system, created_at, updated_at)
       VALUES (?, ?, 'research_scientist', 'Research Scientist', '', 30, 'internal', 0, 1, ?, ?)`,
    )
    .bind(ROLE, ORG, ISO, ISO)
    .run();
  await d1
    .prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)')
    .bind(ROLE, 'file.view')
    .run();
  await d1
    .prepare(
      `INSERT INTO user_roles (id, organization_id, user_id, role_id, scope_type, scope_id, granted_at)
       VALUES ('65f000000000000000000031', ?, ?, ?, 'company', NULL, ?)`,
    )
    .bind(ORG, ALICE, ROLE, ISO)
    .run();
}

async function resetEnv(): Promise<void> {
  const { resetEnvCache } = await import('@/server/config/env');
  resetEnvCache();
}

beforeAll(async () => {
  const generate = () =>
    crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as Promise<CryptoKeyPair>;
  keyPair = await generate();
  foreignKeyPair = await generate();
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] };

  for (const [name, value] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
  for (const name of DATA_SOURCE_MODULES) setDataSourceOverride(name, 'd1');

  d1 = await startTestD1();
  setD1BindingForTesting(d1);
  await seed();
  await resetEnv();
}, 300_000);

afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearDataSourceOverrides();
  setD1BindingForTesting(null);
  await resetEnv();
  await stopTestD1();
});

beforeEach(async () => {
  const { resetGoogleJwksCache } = await import('@/server/auth/google-oauth');
  resetGoogleJwksCache();
  nextIdToken = null;
  tokenRequests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === JWKS_ENDPOINT) return new Response(JSON.stringify(jwks), { status: 200 });
      if (url === TOKEN_ENDPOINT) {
        tokenRequests.push(new URLSearchParams(String(init?.body)));
        return new Response(JSON.stringify({ id_token: nextIdToken }), { status: 200 });
      }
      return realFetch(input as RequestInfo, init);
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const { resetAllRateLimits } = await import('@/server/auth/rate-limit');
  resetAllRateLimits();
});

/* ------------------------------------------------------------------ tests */

describe('starting sign-in', () => {
  it('asks Google for openid email profile only, with PKCE, state and nonce, back to APP_URL', async () => {
    const { location, cookies } = await startSignIn();

    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('scope')).toBe('openid email profile');
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(`${APP_URL}/api/auth/google/callback`);
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('hd')).toBe('exrna.com');
    expect(location.searchParams.get('state')).toBe(cookies.bd_oauth_state);
    expect(location.searchParams.get('nonce')).toBe(cookies.bd_oauth_nonce);
    // The PKCE verifier stays in the browser's HttpOnly cookie; only its hash goes to Google.
    expect(location.search).not.toContain(cookies.bd_oauth_verifier!);
  });
});

describe('a successful exrna.com sign-in', () => {
  it('issues the ordinary application session, with the user’s roles, and no Access check', async () => {
    const response = await signIn('Alice@exrna.com');

    const target = redirectOf(response);
    expect(target.toString()).toBe(`${APP_URL}/home`);

    const cookies = setCookies(response);
    const sessionLine = cookies.get('bd_session')!;
    expect(sessionLine).toMatch(/HttpOnly/i);
    expect(sessionLine).toMatch(/Secure/i); // APP_URL is https, even though NODE_ENV is not production
    expect(sessionLine).toMatch(/SameSite=lax/i);
    // The one-shot OAuth cookies are spent.
    for (const name of ['bd_oauth_state', 'bd_oauth_verifier', 'bd_oauth_nonce']) {
      expect(cookieValue(cookies.get(name))).toBe('');
    }

    // The code was exchanged with the PKCE verifier and the registered redirect URI.
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]!.get('code')).toBe('auth-code');
    expect(tokenRequests[0]!.get('code_verifier')).toBeTruthy();
    expect(tokenRequests[0]!.get('redirect_uri')).toBe(`${APP_URL}/api/auth/google/callback`);

    // No cf-access-jwt-assertion header: in google_oauth mode the session alone is enough.
    const { resolveRequestSession } = await import('@/server/auth/access-session');
    const resolved = await resolveRequestSession(cookieValue(sessionLine), new Headers());
    expect(resolved?.actor.userId).toBe(ALICE);
    expect(resolved?.actor.organizationId).toBe(ORG);
    expect(resolved?.actor.roleKeys).toEqual(['research_scientist']);
    expect([...resolved!.actor.permissions]).toEqual(['file.view']);

    expect(
      await count(`SELECT count(*) AS n FROM login_history WHERE user_id = ? AND outcome = 'success' AND provider = 'google'`, ALICE),
    ).toBeGreaterThan(0);
  });

  it('logout revokes the session and clears its cookies', async () => {
    const response = await signIn('alice@exrna.com');
    const cookies = setCookies(response);
    const token = cookieValue(cookies.get('bd_session'));
    const csrf = cookieValue(cookies.get('bd_csrf'));

    const { POST } = await import('@/app/api/auth/logout/route');
    const logout = await POST(
      new NextRequest(`${APP_URL}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: `bd_session=${token}; bd_csrf=${csrf}`, 'x-csrf-token': csrf, origin: APP_URL },
      }),
      undefined,
    );

    expect(logout.status).toBe(200);
    // Back to the application's own login page: there is no Access session to end.
    expect(await logout.json()).toEqual({ data: { ok: true, redirectTo: '/login' } });
    const cleared = setCookies(logout);
    expect(cookieValue(cleared.get('bd_session'))).toBe('');
    expect(cleared.get('bd_session')).toMatch(/Max-Age=0/i);

    const { resolveRequestSession } = await import('@/server/auth/access-session');
    expect(await resolveRequestSession(token, new Headers())).toBeNull();
  });
});

describe('the account policy still decides', () => {
  it('refuses any address not on the Workspace domain, even one the organisation lists', async () => {
    // A Workspace secondary domain: the account is managed (`hd` matches) and the organisation
    // record lists the domain, but only GOOGLE_WORKSPACE_DOMAIN signs in in google_oauth mode.
    const response = await signIn('carol@exrna-partner.com');

    expect(redirectOf(response).searchParams.get('error')).toBe('domain_rejected');
    expect(setCookies(response).has('bd_session')).toBe(false);
    expect(
      await count(`SELECT count(*) AS n FROM login_history WHERE email = 'carol@exrna-partner.com' AND outcome = 'domain_rejected'`),
    ).toBe(1);
  });

  it('refuses an account from another Workspace, or a consumer account', async () => {
    for (const overrides of [
      { hd: 'other-company.com' },
      { hd: undefined }, // a consumer Google account registered with a company address
    ]) {
      const response = await signIn('mallory@exrna.com', overrides);
      expect(redirectOf(response).searchParams.get('error')).toBe('domain_rejected');
      expect(setCookies(response).has('bd_session')).toBe(false);
    }
    const gmail = await signIn('mallory@gmail.com', { hd: undefined });
    expect(redirectOf(gmail).searchParams.get('error')).toBe('domain_rejected');
  });

  it('refuses an unknown user and does not create one', async () => {
    const before = await count('SELECT count(*) AS n FROM users');
    const response = await signIn('newcomer@exrna.com');

    expect(redirectOf(response).searchParams.get('error')).toBe('not_provisioned');
    expect(setCookies(response).has('bd_session')).toBe(false);
    expect(await count('SELECT count(*) AS n FROM users')).toBe(before);
  });

  it('refuses an unknown user even with auto-provisioning switched on', async () => {
    process.env.ALLOW_AUTO_PROVISIONING = 'true';
    await resetEnv();
    try {
      const before = await count('SELECT count(*) AS n FROM users');
      const response = await signIn('walk-in@exrna.com');

      expect(redirectOf(response).searchParams.get('error')).toBe('not_provisioned');
      expect(setCookies(response).has('bd_session')).toBe(false);
      expect(await count('SELECT count(*) AS n FROM users')).toBe(before);
    } finally {
      process.env.ALLOW_AUTO_PROVISIONING = 'false';
      await resetEnv();
    }
  });

  it('refuses an inactive user and issues no session', async () => {
    const response = await signIn('bob@exrna.com');

    expect(redirectOf(response).searchParams.get('error')).toBe('account_inactive');
    expect(setCookies(response).has('bd_session')).toBe(false);
    expect(await count('SELECT count(*) AS n FROM sessions WHERE user_id = ?', BOB)).toBe(0);
  });

  it('refuses an address Google has not verified', async () => {
    const response = await signIn('alice@exrna.com', { email_verified: false });
    expect(redirectOf(response).searchParams.get('error')).toBe('oauth_failed');
  });
});

describe('state and CSRF', () => {
  it('refuses a callback whose state does not match the browser’s cookie', async () => {
    const started = await startSignIn();
    const response = await callback(started, { state: 'attacker-chosen-state' });

    expect(redirectOf(response).searchParams.get('error')).toBe('oauth_state_mismatch');
    // Refused before the code is ever exchanged.
    expect(tokenRequests).toHaveLength(0);
  });

  it('refuses a callback from a browser that never started the flow', async () => {
    const started = await startSignIn();
    const response = await callback(started, { cookies: {} });

    expect(redirectOf(response).searchParams.get('error')).toBe('oauth_state_missing');
    expect(tokenRequests).toHaveLength(0);
  });

  it('refuses an ID token minted for a different sign-in (nonce)', async () => {
    const response = await signIn('alice@exrna.com', { nonce: 'another-flow' });
    expect(redirectOf(response).searchParams.get('error')).toBe('oauth_failed');
  });
});

describe('ID token verification', () => {
  it('refuses a token issued to another OAuth client (audience)', async () => {
    const response = await signIn('alice@exrna.com', { aud: 'someone-else.apps.googleusercontent.com' });
    expect(redirectOf(response).searchParams.get('error')).toBe('oauth_failed');
    expect(setCookies(response).has('bd_session')).toBe(false);
  });

  it('refuses an expired token', async () => {
    const response = await signIn('alice@exrna.com', { exp: Math.floor(Date.now() / 1000) - 60 });
    expect(redirectOf(response).searchParams.get('error')).toBe('oauth_failed');
  });

  it('refuses a token from another issuer', async () => {
    const response = await signIn('alice@exrna.com', { iss: 'https://evil.example' });
    expect(redirectOf(response).searchParams.get('error')).toBe('oauth_failed');
  });

  it('refuses a token not signed by Google’s key', async () => {
    const response = await signIn('alice@exrna.com', {}, foreignKeyPair);
    expect(redirectOf(response).searchParams.get('error')).toBe('oauth_failed');
  });

  it('refuses a malformed token', async () => {
    const started = await startSignIn();
    nextIdToken = 'not.a-jwt';
    const response = await callback(started);
    expect(redirectOf(response).searchParams.get('error')).toBe('oauth_failed');
  });
});

describe('callback redirect safety', () => {
  it('always lands on APP_URL/home, whatever the query or Host header says', async () => {
    const started = await startSignIn();
    nextIdToken = await idToken(googleClaims('alice@exrna.com', started.cookies.bd_oauth_nonce!));
    const response = await callback(started, {
      host: 'https://evil.example',
      query: '&next=https://evil.example/steal&redirect_uri=https://evil.example&returnTo=//evil.example',
    });

    expect(redirectOf(response).toString()).toBe(`${APP_URL}/home`);
  });

  it('sends failures to APP_URL/login with a fixed error code, never provider text', async () => {
    const started = await startSignIn();
    const response = await callback(started, {
      host: 'https://evil.example',
      query: '&error=<script>alert(1)</script>&error_description=injected',
    });

    const target = redirectOf(response);
    expect(target.origin).toBe(APP_URL);
    expect(target.pathname).toBe('/login');
    expect(target.searchParams.get('error')).toBe('oauth_cancelled');
    expect(target.search).not.toContain('script');
  });
});
