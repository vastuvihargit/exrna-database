/**
 * Cloudflare Access identity — verified server-side, on every request.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────────────────
 *
 * `passwordHash` is Argon2id, produced by `@node-rs/argon2`, a native Rust N-API addon.
 * workerd loads no native code and Argon2id has no WebCrypto equivalent, so those hashes
 * **cannot be verified in a Worker by any means**. `next.config.ts` already replaces the
 * binding with `shims/argon2.worker.ts`, which refuses rather than falling back — substituting
 * PBKDF2 would reject every correct password, which looks like a mass account lockout.
 *
 * The consequence is not "password login is slower in a Worker": it is that a Worker has no
 * password login at all. Identity has to arrive already proven, and Cloudflare Access in front
 * of the Worker is how. That makes this module a deployment prerequisite rather than a feature.
 *
 * ── What is trusted, and what is not ────────────────────────────────────────────────────
 *
 * **Only a signature.** The `Cf-Access-Jwt-Assertion` header is a JWT signed by the team's
 * Access instance; this module fetches that team's public keys and verifies RS256 over the
 * signing input, then checks issuer, audience and both time bounds. Nothing else about the
 * request is evidence of anything.
 *
 * In particular:
 *
 *   • **`Cf-Access-Authenticated-User-Email` is never read.** It is a plaintext header. In
 *     front of a correctly locked-down origin it is set by Cloudflare, but it is trivially
 *     forgeable by anything that can reach the Worker directly, and a Worker URL is public.
 *     Trusting it would make authentication a matter of typing somebody's address into curl.
 *
 *   • **The `aud` claim is checked against a configured value.** Without it, any JWT from *any*
 *     Access application on the same team — including one an attacker can enrol in — verifies
 *     against the same keys. The audience is what binds a token to this application.
 *
 *   • **Google identity does not grant capability.** Access proves *who* the person is. What
 *     they may do still comes from `users`, `user_roles` and `resource_permissions`, resolved
 *     exactly as they are for a password session. This module returns an email address; it
 *     never returns a permission.
 *
 * ── Active-user enforcement ─────────────────────────────────────────────────────────────
 *
 * A verified Access token for someone whose account is `suspended` or `deactivated` is not a
 * login. Access revocation and application deactivation are two different systems, and the
 * application's answer wins — the same rule `resolveSession` already applies on every request
 * for password sessions.
 */
import { UnauthenticatedError, ValidationError } from '@/server/errors/app-error';

/** The signed assertion. The plaintext e-mail header is deliberately absent — see the header. */
export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
export const ACCESS_JWT_COOKIE = 'CF_Authorization';

export interface AccessConfig {
  /** `<team>.cloudflareaccess.com`, without a scheme. */
  teamDomain: string;
  /** The Access application's Audience (AUD) tag. */
  audience: string;
}

export interface AccessIdentity {
  email: string;
  /** The Access user id (`sub`), recorded on the session for correlation with Access logs. */
  subject: string;
  /** The identity provider Access used, e.g. `google`. Informational. */
  identityProvider: string | null;
  expiresAt: Date;
}

interface JwkKey {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ encoding */

/**
 * Base64url decode.
 *
 * Written out rather than using `Buffer`, so this module runs unchanged in workerd where
 * `Buffer` is a `nodejs_compat` shim. Returns `Uint8Array<ArrayBuffer>` because WebCrypto's
 * `BufferSource` excludes `SharedArrayBuffer`.
 */
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeBase64UrlToString(value: string): string {
  return new TextDecoder().decode(decodeBase64Url(value));
}

/* ------------------------------------------------------------------ key material */

/**
 * Keys are cached per team domain for an hour.
 *
 * Access rotates its signing keys, and a cache that never expired would start rejecting every
 * token some hours after a rotation — an outage with no obvious cause. An hour is short enough
 * that a rotation heals on its own and long enough that the certs endpoint is not on the
 * authentication hot path.
 */
const JWKS_TTL_MS = 60 * 60_000;
const jwksCache = new Map<string, { keys: JwkKey[]; fetchedAt: number }>();

/** Test seam: drop cached key material so a suite can serve a fresh JWKS. */
export function resetAccessJwksCache(): void {
  jwksCache.clear();
}

function certsUrl(teamDomain: string): string {
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

async function getAccessKeys(teamDomain: string): Promise<JwkKey[]> {
  const cached = jwksCache.get(teamDomain);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

  const response = await fetch(certsUrl(teamDomain), { cache: 'no-store' });
  if (!response.ok) {
    // Deliberately not falling back to a stale cache or to "allow". An unreachable Access
    // instance means identity cannot be established, and the safe answer is no.
    throw new UnauthenticatedError('Could not fetch Cloudflare Access signing keys');
  }

  const body = (await response.json()) as { keys?: JwkKey[] };
  const keys = body.keys ?? [];
  if (keys.length === 0) throw new UnauthenticatedError('Cloudflare Access returned no signing keys');

  jwksCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

/* ------------------------------------------------------------------ verification */

/**
 * Verifies the Access JWT and returns the identity it asserts.
 *
 * Every failure is an `UnauthenticatedError` with the same shape, so a caller cannot use the
 * error text to distinguish "no such audience" from "bad signature" from "expired".
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
): Promise<AccessIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthenticatedError('Malformed Cloudflare Access token');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(decodeBase64UrlToString(headerPart)) as { alg?: string; kid?: string };
  } catch {
    throw new UnauthenticatedError('Malformed Cloudflare Access token');
  }

  // Pinned before the key is looked up. This refuses `alg: none` and refuses a token asking to
  // be verified symmetrically with the public key as the HMAC secret — the two classic JWT
  // forgeries, both of which otherwise "verify".
  if (header.alg !== 'RS256') {
    throw new UnauthenticatedError('Unsupported Cloudflare Access token algorithm');
  }
  if (!header.kid) throw new UnauthenticatedError('Cloudflare Access token names no signing key');

  const keys = await getAccessKeys(config.teamDomain);
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) throw new UnauthenticatedError('Unknown Cloudflare Access signing key');

  const publicKey = await crypto.subtle.importKey(
    'jwk',
    jwk as unknown as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    decodeBase64Url(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!verified) throw new UnauthenticatedError('Cloudflare Access token signature is invalid');

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(decodeBase64UrlToString(payloadPart)) as Record<string, unknown>;
  } catch {
    throw new UnauthenticatedError('Malformed Cloudflare Access token');
  }

  /**
   * `aud` is a string or an array of strings, and both must be handled.
   *
   * Access emits an array. A check written for the string case only would compare an array to a
   * string, never match, and be "fixed" by removing the check.
   */
  const audience = claims.aud;
  const audiences = Array.isArray(audience) ? audience.map(String) : [String(audience ?? '')];
  if (!audiences.includes(config.audience)) {
    throw new UnauthenticatedError('Cloudflare Access token is for a different application');
  }

  // The issuer is the team domain. Without this, a token minted by *another* Cloudflare team
  // would still verify if its key happened to be fetched.
  const issuer = String(claims.iss ?? '');
  if (issuer !== `https://${config.teamDomain}`) {
    throw new UnauthenticatedError('Cloudflare Access token has an unexpected issuer');
  }

  const now = Date.now();
  const expiry = Number(claims.exp ?? 0);
  if (!Number.isFinite(expiry) || expiry * 1000 <= now) {
    throw new UnauthenticatedError('Cloudflare Access token has expired');
  }

  // `nbf` is checked as well as `exp`: a token that is not yet valid is not valid.
  const notBefore = Number(claims.nbf ?? 0);
  if (Number.isFinite(notBefore) && notBefore > 0 && notBefore * 1000 > now + 60_000) {
    throw new UnauthenticatedError('Cloudflare Access token is not yet valid');
  }

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) throw new UnauthenticatedError('Cloudflare Access token carries no email address');

  const identityProvider =
    typeof claims.idp === 'object' && claims.idp !== null
      ? String((claims.idp as { type?: unknown }).type ?? '') || null
      : null;

  return {
    email,
    subject: String(claims.sub ?? ''),
    identityProvider,
    expiresAt: new Date(expiry * 1000),
  };
}

/* ------------------------------------------------------------------ request extraction */

/**
 * Pulls the assertion off a request.
 *
 * The header is the documented transport and is what a browser navigation carries; the cookie
 * is the fallback for a same-origin `fetch` that Access has already stamped. Only these two —
 * never a query parameter, which would end up in logs and in browser history.
 */
export function readAccessToken(headers: { get(name: string): string | null }): string | null {
  const fromHeader = headers.get(ACCESS_JWT_HEADER);
  if (fromHeader) return fromHeader.trim();

  const cookie = headers.get('cookie');
  if (!cookie) return null;

  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === ACCESS_JWT_COOKIE && rest.length > 0) return rest.join('=').trim();
  }
  return null;
}

/* ------------------------------------------------------------------ configuration */

/**
 * Whether Access is configured on this deployment.
 *
 * Both values are required together. A team domain without an audience is the dangerous
 * half-configuration — it would verify signatures and accept any application's token — so
 * `accessConfigFrom` returns null rather than a partially populated config, and the caller
 * treats null as "not configured" rather than as "no audience check".
 */
export function accessConfigFrom(source: {
  CF_ACCESS_TEAM_DOMAIN?: string | undefined;
  CF_ACCESS_AUD?: string | undefined;
}): AccessConfig | null {
  const teamDomain = source.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = source.CF_ACCESS_AUD?.trim();
  if (!teamDomain || !audience) return null;
  return { teamDomain: teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, ''), audience };
}

/**
 * Refuses a configuration that would be unsafe in production.
 *
 * Called from the Worker environment loader. A production Worker with no Access configuration
 * has no way to authenticate anyone — Argon2id cannot run there — so booting one is not a
 * degraded mode, it is a deployment that will 401 every request. Failing at startup says so.
 */
export function assertAccessConfigured(
  source: { CF_ACCESS_TEAM_DOMAIN?: string | undefined; CF_ACCESS_AUD?: string | undefined },
  isProduction: boolean,
): void {
  if (!isProduction) return;
  if (accessConfigFrom(source)) return;

  throw new ValidationError(
    'Cloudflare Access is not configured. A production Worker cannot verify Argon2id password ' +
      'hashes — @node-rs/argon2 is a native addon workerd cannot load — so Access is the only ' +
      'way to establish identity. Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD.',
  );
}
