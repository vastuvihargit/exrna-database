import type { NextRequest } from 'next/server';

import { withRouteHandler } from '@/server/http/route-handler';
import { ok } from '@/server/http/api-response';
import { forgotPasswordSchema } from '@/server/validation/auth.schemas';
import { authService } from '@/server/services/auth.service';
import { getEnv } from '@/server/config/env';
import { getLogger } from '@/server/logging/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Always responds with the same message, whether or not the address exists.
 * Telling an anonymous caller which addresses are real is the same leak as a
 * distinguishable login error.
 */
export const POST = withRouteHandler(async (request: NextRequest, { requestContext }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = forgotPasswordSchema.parse(body);

  const result = await authService.requestPasswordReset(input.email, {
    requestId: requestContext.requestId,
    ip: requestContext.ip,
    userAgent: requestContext.userAgent,
  });

  if (result) {
    const env = getEnv();
    const resetUrl = new URL('/reset-password', env.APP_URL);
    resetUrl.searchParams.set('token', result.token);

    // SMTP delivery is wired in Phase 7 with the rest of the notification system.
    // Until then the link is logged at info level so an administrator can hand it over
    // — and it is never returned in the response body.
    getLogger().info(
      { userId: result.userId, resetUrl: env.isProduction ? '[redacted]' : resetUrl.toString() },
      'Password reset link generated',
    );
  }

  return ok({
    message: 'If that address belongs to an active account, a reset link has been sent.',
  });
});
