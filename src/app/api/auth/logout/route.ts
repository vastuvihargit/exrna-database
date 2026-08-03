import { NextResponse } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { clearSessionCookies } from '@/server/http/cookies';
import { authService } from '@/server/services/auth.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuthenticatedRoute(async (_request, { actor, meta }) => {
  await authService.logout(actor.sessionId, actor.userId, meta);

  const response = NextResponse.json({ data: { ok: true } });
  clearSessionCookies(response);
  return response;
});
