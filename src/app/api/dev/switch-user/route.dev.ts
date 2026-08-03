import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withRouteHandler } from '@/server/http/route-handler';
import { setSessionCookies, SESSION_COOKIE } from '@/server/http/cookies';
import { assertDevToolingEnabled } from '@/server/config/dev-mode';
import { UnauthenticatedError } from '@/server/errors/app-error';
import { resolveSession } from '@/server/auth/session.service';
import { devSwitcherService } from '@/server/services/dev-switcher.service';
import { toSessionDto } from '@/server/http/dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const switchSchema = z.object({
  userId: z.string().regex(/^[a-f0-9]{24}$/i, 'userId must be an object id'),
});

/**
 * Switches the browser to another development account. **Development builds only.**
 *
 * Issues a real session — the same `issueSession` a password login uses — so every
 * permission check downstream behaves exactly as it would for a genuine sign-in.
 *
 * Not CSRF-token protected, for the same reason `/api/auth/login` is not: there may be
 * no session yet to bind a token to. The origin check below is what stands in for it,
 * and the route does not exist at all outside development. Zod parsing runs before
 * anything reaches the database, so `{"userId": {"$ne": null}}` is a 422 rather than a
 * query operator.
 *
 * The session token is never in the response body. It leaves only as the same HttpOnly
 * cookie a real login sets, so a developer cannot copy one out of the network tab and
 * reuse it somewhere it does not belong.
 */
export const POST = withRouteHandler(async (request: NextRequest, { requestContext }) => {
  assertDevToolingEnabled();
  assertSameOrigin(request);

  const body: unknown = await request.json().catch(() => ({}));
  const input = switchSchema.parse(body);

  // Revoke whatever session is currently in the browser rather than orphaning it —
  // otherwise a morning of switching leaves a dozen live sessions behind, which would
  // quietly undermine the "sign out everywhere" the account page offers.
  const currentToken = request.cookies.get(SESSION_COOKIE)?.value;
  const current = await resolveSession(currentToken);

  const { session } = await devSwitcherService.switchToUser({
    targetUserId: input.userId,
    currentSessionId: current?.sessionId ?? null,
    meta: {
      requestId: requestContext.requestId,
      ip: requestContext.ip,
      userAgent: requestContext.userAgent,
      origin: request.headers.get('origin'),
    },
  });

  const resolved = await resolveSession(session.token);
  const response = NextResponse.json(
    { data: resolved ? toSessionDto(resolved.actor) : null },
    { status: 200 },
  );

  setSessionCookies(response, {
    token: session.token,
    csrfToken: session.csrfToken,
    expiresAt: session.absoluteExpiresAt,
  });

  return response;
});

/**
 * Rejects a cross-site POST.
 *
 * Weaker than the CSRF token the authenticated routes use, and deliberately so — there
 * is no session to bind a token to before the first switch. It is sufficient here
 * because the endpoint is absent in production and can only ever reach seeded
 * development accounts.
 */
function assertSameOrigin(request: NextRequest): void {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new UnauthenticatedError('Cross-site request rejected');
  }

  const origin = request.headers.get('origin');
  if (!origin) return;

  const requestUrl = new URL(request.url);
  let originUrl: URL | null = null;
  try {
    originUrl = new URL(origin);
  } catch {
    originUrl = null;
  }

  if (!originUrl || originUrl.host !== requestUrl.host) {
    throw new UnauthenticatedError('Cross-site request rejected');
  }
}
