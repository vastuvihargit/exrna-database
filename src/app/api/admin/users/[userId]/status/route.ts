import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toUserDto } from '@/server/http/dto';
import { userService } from '@/server/services/user.service';
import { setUserStatusSchema } from '@/server/validation/user.schemas';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Activate, suspend or deactivate an employee.
 *
 * Deactivation revokes every live session immediately; the per-request status check in
 * session resolution makes any in-flight request fail as well.
 */
export const POST = withAuthenticatedRoute<{ userId: string }>(
  async (request: NextRequest, { params, actor, meta }) => {
    const userId = objectIdSchema.parse(params.userId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = setUserStatusSchema.parse(body);

    const user = await userService.setStatus(actor, userId, input.status, input.reason ?? null, meta);
    return ok(toUserDto(user));
  },
);
