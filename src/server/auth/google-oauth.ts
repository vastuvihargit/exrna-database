/**
 * Google Workspace OAuth 2.0 with PKCE.
 *
 * Implemented directly against the endpoints rather than through a framework, because
 * the security-relevant steps must be visible and testable:
 *   • `state` binds the callback to the browser that started the flow (CSRF)
 *   • PKCE binds the code to this client (code interception)
 *   • `nonce` binds the ID token to this request (token replay)
 *   • the ID token's signature, issuer, audience and expiry are all verified
 *   • the *email domain* — not the `hd` claim — decides who may sign in
 */
import { createHash, randomBytes } from 'crypto';
import { getEnv } from '@/server/config/env';
import { ValidationError } from '@/server/errors/app-error';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export interface OAuthStart {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  nonce: string;
}

export function isGoogleConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

export function beginGoogleLogin(hostedDomainHint?: string): OAuthStart {
  const env = getEnv();
  if (!isGoogleConfigured()) {
    throw new ValidationError('Google sign-in is not configured on this deployment');
  }

  const state = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(48));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: env.GOOGLE_REDIRECT_URI!,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'online',
    prompt: 'select_account',
  });

  // A hint only — it improves the account picker but is never treated as a control.
  if (hostedDomainHint) params.set('hd', hostedDomainHint);

  return { authorizationUrl: `${AUTH_ENDPOINT}?${params.toString()}`, state, codeVerifier, nonce };
}

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  subject: string;
  hostedDomain?: string;
}

/** The index signature matches Node's JsonWebKey so the key can be passed straight through. */
interface JwkKey {
  kid: string;
  n: string;
  e: string;
  kty: string;
  alg: string;
  use: string;
  [key: string]: unknown;
}

let jwksCache: { keys: JwkKey[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60_000;

async function getJwks(): Promise<JwkKey[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;

  const response = await fetch(JWKS_ENDPOINT, { cache: 'no-store' });
  if (!response.ok) throw new ValidationError('Could not fetch Google signing keys');
  const body = (await response.json()) as { keys: JwkKey[] };
  jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

/** Verifies RS256 over the JWT's signing input using the matching JWKS key. */
async function verifyIdTokenSignature(idToken: string): Promise<Record<string, unknown>> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new ValidationError('Malformed ID token');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as {
    alg: string;
    kid: string;
  };
  if (header.alg !== 'RS256') throw new ValidationError('Unsupported ID token algorithm');

  const keys = await getJwks();
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) throw new ValidationError('Unknown ID token signing key');

  const { createPublicKey, createVerify } = await import('crypto');
  // The JWKS entry is a JSON Web Key; Node accepts it directly with format 'jwk'.
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();

  if (!verifier.verify(publicKey, Buffer.from(signaturePart, 'base64url'))) {
    throw new ValidationError('ID token signature verification failed');
  }

  return JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export async function completeGoogleLogin(input: {
  code: string;
  codeVerifier: string;
  expectedNonce: string;
}): Promise<GoogleIdentity> {
  const env = getEnv();
  if (!isGoogleConfigured()) throw new ValidationError('Google sign-in is not configured');

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: input.code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: env.GOOGLE_REDIRECT_URI!,
      grant_type: 'authorization_code',
      code_verifier: input.codeVerifier,
    }),
    cache: 'no-store',
  });

  if (!response.ok) throw new ValidationError('Google rejected the sign-in attempt');

  const tokens = (await response.json()) as { id_token?: string };
  if (!tokens.id_token) throw new ValidationError('Google did not return an ID token');

  const claims = await verifyIdTokenSignature(tokens.id_token);

  const issuer = String(claims.iss ?? '');
  const audience = String(claims.aud ?? '');
  const expiry = Number(claims.exp ?? 0);
  const nonce = String(claims.nonce ?? '');

  if (!ISSUERS.has(issuer)) throw new ValidationError('Unexpected ID token issuer');
  if (audience !== env.GOOGLE_CLIENT_ID) throw new ValidationError('Unexpected ID token audience');
  if (!Number.isFinite(expiry) || expiry * 1000 <= Date.now()) throw new ValidationError('ID token has expired');
  if (nonce !== input.expectedNonce) throw new ValidationError('ID token nonce mismatch');

  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  // An unverified address at Google is not proof of control of that mailbox.
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  if (!email || !emailVerified) throw new ValidationError('Google account email is not verified');

  return {
    email,
    emailVerified,
    ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
    ...(typeof claims.picture === 'string' ? { picture: claims.picture } : {}),
    subject: String(claims.sub ?? ''),
    ...(typeof claims.hd === 'string' ? { hostedDomain: claims.hd } : {}),
  };
}
