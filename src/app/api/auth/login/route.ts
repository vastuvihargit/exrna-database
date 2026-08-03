import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { withRouteHandler } from '@/server/http/route-handler';
import { setSessionCookies } from '@/server/http/cookies';
import { loginSchema } from '@/server/validation/auth.schemas';
import { authService } from '@/server/services/auth.service';
import { resolveSession } from '@/server/auth/session.service';
import { toSessionDto } from '@/server/http/dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Password sign-in.
 *
 * Not CSRF-protected: there is no session to protect yet, and the endpoint is
 * rate-limited per IP and per address. Zod parsing runs before anything reaches the
 * database, so `{"email": {"$ne": null}}` is a 422 rather than a query operator.
 */
export const POST = withRouteHandler(async (request: NextRequest, { requestContext }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = loginSchema.parse(body);

  const session = await authService.loginWithPassword(input, {
    requestId: requestContext.requestId,
    ip: requestContext.ip,
    userAgent: requestContext.userAgent,
    origin: request.headers.get('origin'),
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
