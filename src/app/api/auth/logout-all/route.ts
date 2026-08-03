import { NextResponse } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { clearSessionCookies } from '@/server/http/cookies';
import { authService } from '@/server/services/auth.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Signs the user out on every device, including this one. */
export const POST = withAuthenticatedRoute(async (_request, { actor, meta }) => {
  const revoked = await authService.logoutEverywhere(actor.userId, meta);

  const response = NextResponse.json({ data: { sessionsRevoked: revoked } });
  clearSessionCookies(response);
  return response;
});
