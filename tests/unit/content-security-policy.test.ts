/**
 * The per-request nonce CSP: the policy itself, and the middleware that sends it.
 *
 * The property that fixes the blank /login is that the nonce in the response's policy is the
 * *same* nonce forwarded on the request — Next.js reads that one when it stamps its inline
 * bootstrap scripts. Different nonces, or a policy only on one side, and hydration is blocked
 * again. The rendered-HTML half — every <script> in /login carries that nonce — needs the real
 * renderer, and is checked against the built Worker rather than here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  NONCE_HEADER,
  buildContentSecurityPolicy,
  generateNonce,
} from '@/lib/security/content-security-policy';
import { middleware } from '@/middleware';

const ORIGIN = 'https://staging.exrna.test';

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name!, values.join(' ')];
    }),
  );
}

/** What the middleware forwarded to the renderer as request header `name`. */
function forwarded(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name.toLowerCase()}`);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildContentSecurityPolicy', () => {
  it('allows scripts by nonce and strict-dynamic in production, never unsafe-inline', () => {
    const policy = directives(buildContentSecurityPolicy({ nonce: 'abc123==', development: false }));
    expect(policy.get('script-src')).toBe("'self' 'nonce-abc123==' 'strict-dynamic'");
    expect(policy.get('script-src')).not.toContain('unsafe');
  });

  it('adds unsafe-eval only in development, for React refresh', () => {
    const policy = directives(buildContentSecurityPolicy({ nonce: 'n', development: true }));
    expect(policy.get('script-src')).toBe("'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval'");
    expect(policy.get('script-src')).not.toContain('unsafe-inline');
  });

  it('keeps every other protection exactly as before', () => {
    const policy = directives(buildContentSecurityPolicy({ nonce: 'n', development: false }));
    expect(Object.fromEntries([...policy].filter(([name]) => name !== 'script-src'))).toEqual({
      'default-src': "'self'",
      'style-src': "'self' 'unsafe-inline'",
      'img-src': "'self' blob: data:",
      'media-src': "'self' blob:",
      'font-src': "'self'",
      'connect-src': "'self'",
      // `'self'`: the preview dialog embeds same-origin PDFs with <object>.
      'object-src': "'self'",
      'frame-ancestors': "'none'",
      'base-uri': "'none'",
      'form-action': "'self'",
    });
  });

  it('without a nonce (API responses) allows same-origin scripts only', () => {
    const policy = directives(buildContentSecurityPolicy({ nonce: null, development: false }));
    expect(policy.get('script-src')).toBe("'self'");
  });
});

describe('generateNonce', () => {
  it('is 128 bits of base64 and different every time', () => {
    const nonces = new Set(Array.from({ length: 50 }, generateNonce));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe('middleware', () => {
  it('sends /login a nonce policy and forwards the same nonce to the renderer', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = middleware(new NextRequest(`${ORIGIN}/login`));

    const policy = response.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    expect(directives(policy).get('script-src')).toBe(`'self' 'nonce-${nonce}' 'strict-dynamic'`);

    // Rendered, not redirected, and Next.js receives the identical policy and nonce.
    expect(response.headers.get('location')).toBeNull();
    expect(forwarded(response, 'content-security-policy')).toBe(policy);
    expect(forwarded(response, NONCE_HEADER)).toBe(nonce);
  });

  it('mints a new nonce for every request', () => {
    const first = middleware(new NextRequest(`${ORIGIN}/login`)).headers.get('content-security-policy');
    const second = middleware(new NextRequest(`${ORIGIN}/login`)).headers.get('content-security-policy');
    expect(first).not.toBe(second);
  });

  it('still redirects an unauthenticated page request to /login, with a policy on the redirect', () => {
    const response = middleware(new NextRequest(`${ORIGIN}/home`));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('keeps the session redirect away from /login', () => {
    const request = new NextRequest(`${ORIGIN}/login`, { headers: { cookie: 'bd_session=abc' } });
    expect(new URL(middleware(request).headers.get('location')!).pathname).toBe('/home');
  });
});
