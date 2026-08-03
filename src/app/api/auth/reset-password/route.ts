import type { NextRequest } from 'next/server';

import { withRouteHandler } from '@/server/http/route-handler';
import { ok } from '@/server/http/api-response';
import { resetPasswordSchema } from '@/server/validation/auth.schemas';
import { authService } from '@/server/services/auth.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Completes a reset. Success revokes every existing session for that account. */
export const POST = withRouteHandler(async (request: NextRequest, { requestContext }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = resetPasswordSchema.parse(body);

  await authService.completePasswordReset(input, {
    requestId: requestContext.requestId,
    ip: requestContext.ip,
    userAgent: requestContext.userAgent,
  });

  return ok({ message: 'Your password has been changed. Please sign in.' });
});
