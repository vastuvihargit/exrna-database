import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { withRouteHandler } from '@/server/http/route-handler';
import { getEnv } from '@/server/config/env';
import { SESSION_COOKIE, clearSessionCookies } from '@/server/http/cookies';
import { resolveRequestSession, signInPath } from '@/server/auth/access-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Where a page sends a browser whose session cookie no longer resolves — revoked by a role
 * change, deactivated, expired.
 *
 * The page guard cannot clear the cookie (a server component cannot set cookies), and the
 * middleware only sees that a cookie is *present*, so it bounces `/login` back to `/home`: the
 * browser loops until it gives up with "too many redirects" and the person cannot reach the
 * sign-in page at all. This route clears the dead cookie, then sends them to sign in.
 *
 * It clears nothing while the session is still valid, so a link to it from another site cannot
 * sign anybody out.
 */
export const GET = withRouteHandler(async (request: NextRequest) => {
  const env = getEnv();
  const next = request.nextUrl.searchParams.get('next') ?? undefined;
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : undefined;

  const resolved = await resolveRequestSession(request.cookies.get(SESSION_COOKIE)?.value, request.headers);
  if (resolved) return NextResponse.redirect(new URL(safeNext ?? '/home', env.APP_URL));

  const response = NextResponse.redirect(new URL(signInPath(safeNext), env.APP_URL));
  clearSessionCookies(response);
  return response;
});
