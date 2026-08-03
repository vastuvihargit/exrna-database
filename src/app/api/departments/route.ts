import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created, ok } from '@/server/http/api-response';
import { toDepartmentDto } from '@/server/http/dto';
import { departmentService } from '@/server/services/department.service';
import { createDepartmentSchema } from '@/server/validation/user.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  const departments = await departmentService.list(actor);
  return ok(departments.map(toDepartmentDto));
});

export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor, meta }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = createDepartmentSchema.parse(body);

  const department = await departmentService.create(
    actor,
    {
      name: input.name,
      code: input.code,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.headUserId !== undefined ? { headUserId: input.headUserId } : {}),
      ...(input.parentDepartmentId !== undefined ? { parentDepartmentId: input.parentDepartmentId } : {}),
      ...(input.storageQuotaGb !== undefined ? { storageQuotaGb: input.storageQuotaGb } : {}),
    },
    meta,
  );

  return created(toDepartmentDto(department));
});
