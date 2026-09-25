import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware — a *routing* guard, not a security boundary.
 *
 * It only checks whether a session cookie is present, so an unauthenticated visitor
 * lands on /login instead of a flash of empty application shell. It cannot validate the
 * session: that needs the database, which is not available in the edge runtime.
 *
 * Real enforcement happens server-side on every request:
 *   • API routes  → withAuthenticatedRoute → resolveSession (re-reads user status)
 *   • Pages       → requireActor() in the (drive) and (admin) layouts
 *
 * A forged cookie gets past this file and fails immediately at the next step.
 *
 * ── Cloudflare Access ───────────────────────────────────────────────────────────────────
 *
 * A request that arrived through Access carries its signed assertion (header or
 * `CF_Authorization` cookie). With no application session yet, such a browser is sent to the
 * Access sign-in bridge rather than the password page — the bridge verifies the assertion
 * server-side. The presence check here decides only *where to send* the browser; nothing is
 * trusted because of it.
 */
const SESSION_COOKIE = 'bd_session';
const ACCESS_HEADER = 'cf-access-jwt-assertion';
const ACCESS_COOKIE = 'CF_Authorization';

const PUBLIC_PATHS = ['/login', '/forgot-password', '/reset-password', '/access-denied'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const isPublic = PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  const cameThroughAccess = Boolean(
    request.headers.get(ACCESS_HEADER) || request.cookies.get(ACCESS_COOKIE)?.value,
  );

  if (!hasSessionCookie && cameThroughAccess && (pathname === '/login' || !isPublic)) {
    const bridge = new URL('/api/auth/access', request.url);
    if (pathname !== '/' && pathname !== '/login') bridge.searchParams.set('next', pathname);
    return NextResponse.redirect(bridge);
  }

  if (!hasSessionCookie && !isPublic) {
    const loginUrl = new URL('/login', request.url);
    // Round-trip the intended destination, but only as a path — an absolute URL here
    // would be an open-redirect gadget.
    if (pathname !== '/') loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (hasSessionCookie && (pathname === '/login' || pathname === '/')) {
    return NextResponse.redirect(new URL('/home', request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Everything except API routes (which guard themselves), static assets and metadata.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|favicon.svg|robots.txt).*)'],
};
