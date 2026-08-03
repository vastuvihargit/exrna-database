/**
 * Cookie policy.
 *
 * Session cookie: HttpOnly (JavaScript cannot read it, so XSS cannot steal it),
 * Secure in production, SameSite=Lax (survives normal navigation, blocks cross-site
 * POSTs), Path=/, and no Domain attribute so it is not shared with sub-domains.
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
  const secure = getEnv().isProduction;

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
  const secure = getEnv().isProduction;
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
