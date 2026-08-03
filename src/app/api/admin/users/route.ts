import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created, ok } from '@/server/http/api-response';
import { toUserDto } from '@/server/http/dto';
import { userService } from '@/server/services/user.service';
import { createUserSchema, listUsersQuerySchema } from '@/server/validation/user.schemas';
import { parseQuery } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const query = parseQuery(listUsersQuerySchema, request.url);

  const { items, total } = await userService.listForAdmin(actor, {
    ...(query.search ? { search: query.search } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    page: query.page,
    pageSize: query.pageSize,
    ...(query.sort ? { sort: query.sort } : {}),
    ...(query.order ? { order: query.order } : {}),
  });

  return ok(items.map(toUserDto), {
    meta: { page: query.page, pageSize: query.pageSize, total },
  });
});

/** Creates an employee account. There is no self-service registration endpoint anywhere. */
export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor, meta }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = createUserSchema.parse(body);

  const user = await userService.createEmployee(
    actor,
    {
      email: input.email,
      name: input.name,
      ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle } : {}),
      ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.roleKey !== undefined ? { roleKey: input.roleKey } : {}),
      ...(input.temporaryPassword !== undefined ? { temporaryPassword: input.temporaryPassword } : {}),
      ...(input.storageQuotaGb !== undefined ? { storageQuotaGb: input.storageQuotaGb } : {}),
    },
    meta,
  );

  return created(toUserDto(user));
});
