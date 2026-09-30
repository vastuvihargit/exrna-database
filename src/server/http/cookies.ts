/**
 * Cookie policy.
 *
 * Session cookie: HttpOnly (JavaScript cannot read it, so XSS cannot steal it),
 * Secure in production and whenever APP_URL is https, SameSite=Lax (survives normal
 * navigation, blocks cross-site POSTs), Path=/, and no Domain attribute so it is not shared
 * with sub-domains.
 *
 * CSRF cookie: deliberately readable by JavaScript — the double-submit pattern needs
 * the client to echo it in a header. It is not a credential on its own.
 */
import type { NextResponse } from 'next/server';
import { getEnv } from '@/server/config/env';

export const SESSION_COOKIE = 'bd_session';
export const CSRF_COOKIE = 'bd_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function setSessionCookies(
  response: NextResponse,
  input: { token: string; csrfToken: string; expiresAt: Date },
): void {
  const secure = cookieSecure();

  response.cookies.set(SESSION_COOKIE, input.token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: input.expiresAt,
  });

  response.cookies.set(CSRF_COOKIE, input.csrfToken, {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: input.expiresAt,
  });
}

export function clearSessionCookies(response: NextResponse): void {
  const secure = cookieSecure();
  for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
    response.cookies.set(name, '', {
      httpOnly: name === SESSION_COOKIE,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
  }
}

/**
 * Secure in production and on any deployment served over https — staging runs with
 * `NODE_ENV=staging` on an https hostname and must not send its session cookie in the clear.
 * Plain-http local development is the only case left without it.
 */
export function cookieSecure(): boolean {
  const env = getEnv();
  return env.isProduction || env.APP_URL.startsWith('https://');
}
