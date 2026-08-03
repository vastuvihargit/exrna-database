import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toUserDto } from '@/server/http/dto';
import { userService } from '@/server/services/user.service';
import { updateUserSchema } from '@/server/validation/user.schemas';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute<{ userId: string }>(async (_request, { params, actor }) => {
  const userId = objectIdSchema.parse(params.userId);
  return ok(toUserDto(await userService.getById(actor, userId)));
});

export const PATCH = withAuthenticatedRoute<{ userId: string }>(
  async (request: NextRequest, { params, actor, meta }) => {
    const userId = objectIdSchema.parse(params.userId);
    const body: unknown = await request.json().catch(() => ({}));
    // .strict() — an attempt to slip in `isSuperAdmin` or `status` is a 422, not a silent drop.
    const input = updateUserSchema.parse(body);

    const user = await userService.updateEmployee(
      actor,
      userId,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle } : {}),
        ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
        ...(input.storageQuotaGb !== undefined ? { storageQuotaGb: input.storageQuotaGb } : {}),
      },
      meta,
    );

    return ok(toUserDto(user));
  },
);
