import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { setSessionCookies } from '@/server/http/cookies';
import { changePasswordSchema } from '@/server/validation/auth.schemas';
import { authService } from '@/server/services/auth.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Requires the current password even inside an active session.
 *
 * Every session is revoked, including this one, and a fresh session is issued for this
 * device — so other devices are signed out while the user stays signed in here.
 */
export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor, meta }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = changePasswordSchema.parse(body);

  const session = await authService.changePassword(
    {
      userId: actor.userId,
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
      sessionId: actor.sessionId,
    },
    meta,
  );

  const response = NextResponse.json({
    data: { message: 'Password changed. Other devices have been signed out.' },
  });

  setSessionCookies(response, {
    token: session.token,
    csrfToken: session.csrfToken,
    expiresAt: session.absoluteExpiresAt,
  });

  return response;
});
