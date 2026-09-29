import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { withRouteHandler } from '@/server/http/route-handler';
import { getEnv } from '@/server/config/env';
import { setSessionCookies } from '@/server/http/cookies';
import { accessConfig } from '@/server/auth/access-session';
import { readAccessToken } from '@/server/auth/cloudflare-access';
import { authService } from '@/server/services/auth.service';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@/server/errors/app-error';
import { getLogger } from '@/server/logging/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The Cloudflare Access sign-in bridge.
 *
 * A browser reaches this having already passed Access, so the request carries a signed
 * assertion. This verifies it server-side (`completeAccessLogin` → `verifyAccessJwt`), resolves
 * the employee by the *verified* e-mail and applies the same account policy as every other
 * sign-in — company domain, provisioning, active status — then issues an application session.
 *
 * Unauthenticated by necessity: it is how a session is obtained. It is on the public-route
 * allow-list for that reason, and it exists only when Access is configured (404 otherwise).
 *
 * Failures redirect to /access-denied with a coarse reason code. Nothing from the token or the
 * error is reflected into the page.
 */
export const GET = withRouteHandler(async (request: NextRequest, { requestContext }) => {
  const config = accessConfig();
  if (!config) throw new NotFoundError('Not found');

  const env = getEnv();
  const next = request.nextUrl.searchParams.get('next');
  // A path only, so `?next=https://elsewhere` cannot become an open redirect.
  const destination = next && next.startsWith('/') && !next.startsWith('//') ? next : '/home';

  const denied = (reason: string) =>
    NextResponse.redirect(new URL(`/access-denied?reason=${reason}`, env.APP_URL));

  const token = readAccessToken(request.headers);
  if (!token) return denied('access_missing');

  try {
    const session = await authService.completeAccessLogin(
      { token, config },
      {
        requestId: requestContext.requestId,
        ip: requestContext.ip,
        userAgent: requestContext.userAgent,
      },
    );

    const response = NextResponse.redirect(new URL(destination, env.APP_URL));
    setSessionCookies(response, {
      token: session.token,
      csrfToken: session.csrfToken,
      expiresAt: session.absoluteExpiresAt,
    });
    return response;
  } catch (error) {
    getLogger().warn(
      { err: error, requestId: requestContext.requestId },
      'Cloudflare Access sign-in refused',
    );
    if (error instanceof ForbiddenError) {
      const message = error.message.toLowerCase();
      if (message.includes('not been set up')) return denied('not_provisioned');
      if (message.includes('not active')) return denied('deactivated');
      return denied('domain');
    }
    if (error instanceof UnauthenticatedError) return denied('access_invalid');
    throw error;
  }
});
