/**
 * Cloudflare Access token verification.
 *
 * Every assertion here is about a forgery being refused, because that is the entire job of this
 * module: in a Worker there is no password login — Argon2id cannot run there — so a verified
 * Access token *is* the authentication. A bug in this file is not a degraded experience, it is
 * anonymous access.
 *
 * The suite signs real RS256 tokens with a generated key pair and serves a real JWKS through a
 * stubbed `fetch`, so the code under test runs its actual WebCrypto path rather than a mock of
 * it. A test that stubbed `verifyAccessJwt` itself would prove nothing about the two forgeries
 * that matter (`alg: none` and the audience swap), because both are defeated inside it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accessConfigFrom,
  assertAccessConfigured,
  readAccessToken,
  resetAccessJwksCache,
  verifyAccessJwt,
} from '@/server/auth/cloudflare-access';

const TEAM_DOMAIN = 'acme.cloudflareaccess.com';
const AUDIENCE = 'a'.repeat(64);
const CONFIG = { teamDomain: TEAM_DOMAIN, audience: AUDIENCE };
const KID = 'test-key-1';

let keyPair: CryptoKeyPair;
let jwks: { keys: unknown[] };

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Signs a real RS256 JWT with the generated private key. */
async function sign(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const headerPart = encodeJson({ alg: 'RS256', kid: KID, typ: 'JWT', ...header });
  const payloadPart = encodeJson(claims);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  return `${headerPart}.${payloadPart}.${base64url(new Uint8Array(signature))}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `https://${TEAM_DOMAIN}`,
    aud: [AUDIENCE],
    sub: 'access-user-1',
    email: 'Rosalind.Franklin@Acme.com',
    exp: now + 600,
    iat: now - 10,
    nbf: now - 10,
    idp: { type: 'google' },
    ...overrides,
  };
}

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] };
}, 30_000);

beforeEach(() => {
  resetAccessJwksCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
        return new Response(JSON.stringify(jwks), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a genuine token', () => {
  it('verifies and yields the identity', async () => {
    const identity = await verifyAccessJwt(await sign(validClaims()), CONFIG);

    expect(identity.email).toBe('rosalind.franklin@acme.com');
    expect(identity.subject).toBe('access-user-1');
    expect(identity.identityProvider).toBe('google');
    expect(identity.expiresAt).toBeInstanceOf(Date);
  });

  /** Access emits `aud` as an array; a check written for the string case would never match. */
  it('accepts a string audience as well as an array', async () => {
    const identity = await verifyAccessJwt(await sign(validClaims({ aud: AUDIENCE })), CONFIG);
    expect(identity.email).toBe('rosalind.franklin@acme.com');
  });

  it('fetches the signing keys once and caches them', async () => {
    await verifyAccessJwt(await sign(validClaims()), CONFIG);
    await verifyAccessJwt(await sign(validClaims()), CONFIG);

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe('forgeries', () => {
  /**
   * The classic one. `alg: none` with an empty signature verifies under any implementation that
   * reads the algorithm out of the token instead of pinning it.
   */
  it('refuses alg: none', async () => {
    const headerPart = encodeJson({ alg: 'none', kid: KID, typ: 'JWT' });
    const payloadPart = encodeJson(validClaims());

    await expect(verifyAccessJwt(`${headerPart}.${payloadPart}.`, CONFIG)).rejects.toThrow();
  });

  /**
   * The other classic: ask for HS256 so the verifier uses the *public* key as an HMAC secret.
   * The public key is published, so anybody can produce a valid signature that way.
   */
  it('refuses an HS256 token', async () => {
    const headerPart = encodeJson({ alg: 'HS256', kid: KID, typ: 'JWT' });
    const payloadPart = encodeJson(validClaims());

    await expect(
      verifyAccessJwt(`${headerPart}.${payloadPart}.c2lnbmF0dXJl`, CONFIG),
    ).rejects.toThrow();
  });

  it('refuses a tampered payload', async () => {
    const token = await sign(validClaims());
    const [header, , signature] = token.split('.') as [string, string, string];
    const swapped = encodeJson(validClaims({ email: 'attacker@acme.com' }));

    await expect(verifyAccessJwt(`${header}.${swapped}.${signature}`, CONFIG)).rejects.toThrow();
  });

  it('refuses an unknown signing key', async () => {
    await expect(verifyAccessJwt(await sign(validClaims(), { kid: 'other' }), CONFIG)).rejects.toThrow();
  });

  /**
   * Without the audience check, a token from *any* Access application on the same team verifies
   * against the same keys — including one an attacker can enrol themselves in.
   */
  it('refuses a token minted for a different Access application', async () => {
    const token = await sign(validClaims({ aud: ['b'.repeat(64)] }));
    await expect(verifyAccessJwt(token, CONFIG)).rejects.toThrow();
  });

  it('refuses a token from a different Cloudflare team', async () => {
    const token = await sign(validClaims({ iss: 'https://evil.cloudflareaccess.com' }));
    await expect(verifyAccessJwt(token, CONFIG)).rejects.toThrow();
  });

  it('refuses an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      verifyAccessJwt(await sign(validClaims({ exp: now - 1 })), CONFIG),
    ).rejects.toThrow();
  });

  it('refuses a token that is not yet valid', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      verifyAccessJwt(await sign(validClaims({ nbf: now + 3600 })), CONFIG),
    ).rejects.toThrow();
  });

  it('refuses a token carrying no email address', async () => {
    await expect(verifyAccessJwt(await sign(validClaims({ email: '' })), CONFIG)).rejects.toThrow();
  });

  it('refuses a malformed token', async () => {
    await expect(verifyAccessJwt('not.a.jwt', CONFIG)).rejects.toThrow();
    await expect(verifyAccessJwt('onepart', CONFIG)).rejects.toThrow();
  });

  /** An unreachable Access instance means identity cannot be established. The answer is no. */
  it('refuses when the signing keys cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    await expect(verifyAccessJwt(await sign(validClaims()), CONFIG)).rejects.toThrow();
  });
});

describe('reading the assertion off a request', () => {
  it('prefers the header', () => {
    const headers = new Headers({ 'cf-access-jwt-assertion': 'from-header' });
    expect(readAccessToken(headers)).toBe('from-header');
  });

  it('falls back to the cookie', () => {
    const headers = new Headers({ cookie: 'other=1; CF_Authorization=from-cookie; more=2' });
    expect(readAccessToken(headers)).toBe('from-cookie');
  });

  it('returns null when neither is present', () => {
    expect(readAccessToken(new Headers())).toBeNull();
    expect(readAccessToken(new Headers({ cookie: 'session=abc' }))).toBeNull();
  });

  /**
   * The plaintext email header is never consulted. It is forgeable by anything that can reach
   * the Worker directly, and a Worker URL is public.
   */
  it('ignores the plaintext authenticated-user-email header', () => {
    const headers = new Headers({ 'cf-access-authenticated-user-email': 'ceo@acme.com' });
    expect(readAccessToken(headers)).toBeNull();
  });
});

describe('configuration', () => {
  it('requires both the team domain and the audience', () => {
    expect(accessConfigFrom({ CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUDIENCE })).toEqual(
      CONFIG,
    );
    // A team domain with no audience is the dangerous half-configuration: it would verify
    // signatures and accept any application's token.
    expect(accessConfigFrom({ CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN })).toBeNull();
    expect(accessConfigFrom({ CF_ACCESS_AUD: AUDIENCE })).toBeNull();
    expect(accessConfigFrom({})).toBeNull();
  });

  it('normalises a team domain given with a scheme or a trailing slash', () => {
    expect(
      accessConfigFrom({
        CF_ACCESS_TEAM_DOMAIN: `https://${TEAM_DOMAIN}/`,
        CF_ACCESS_AUD: AUDIENCE,
      }),
    ).toEqual(CONFIG);
  });

  it('refuses to boot a production Worker with Access unconfigured', () => {
    expect(() => assertAccessConfigured({}, true)).toThrow(/Cloudflare Access is not configured/);
    // Outside production the preview path is allowed to boot without it.
    expect(() => assertAccessConfigured({}, false)).not.toThrow();
    expect(() =>
      assertAccessConfigured(
        { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUDIENCE },
        true,
      ),
    ).not.toThrow();
  });
});
