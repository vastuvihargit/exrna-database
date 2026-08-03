import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { userService } from '@/server/services/user.service';
import { grantRoleSchema, revokeRoleSchema } from '@/server/validation/user.schemas';
import { objectIdSchema } from '@/server/validation/common';
import { toUserDto } from '@/server/http/dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Grant a role at a scope. Guarded against escalation in two ways: you cannot grant a
 * role ranked at or above your own, and you cannot grant a permission you lack.
 */
export const POST = withAuthenticatedRoute<{ userId: string }>(
  async (request: NextRequest, { params, actor, meta }) => {
    const userId = objectIdSchema.parse(params.userId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = grantRoleSchema.parse(body);

    await userService.grantRole(
      actor,
      {
        userId,
        ...(input.roleKey !== undefined ? { roleKey: input.roleKey } : {}),
        ...(input.roleId !== undefined ? { roleId: input.roleId } : {}),
        scopeType: input.scopeType,
        scopeId: input.scopeId ?? null,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      },
      meta,
    );

    return ok(toUserDto(await userService.getById(actor, userId)));
  },
);

export const DELETE = withAuthenticatedRoute<{ userId: string }>(
  async (request: NextRequest, { params, actor, meta }) => {
    const userId = objectIdSchema.parse(params.userId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = revokeRoleSchema.parse(body);

    await userService.revokeRole(actor, { userId, grantId: input.grantId }, meta);
    return ok(toUserDto(await userService.getById(actor, userId)));
  },
);
