import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toDepartmentDto } from '@/server/http/dto';
import { departmentService } from '@/server/services/department.service';
import { deleteDepartmentSchema, updateDepartmentSchema } from '@/server/validation/user.schemas';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute<{ departmentId: string }>(
  async (_request, { params, actor }) => {
    const id = objectIdSchema.parse(params.departmentId);
    return ok(toDepartmentDto(await departmentService.getById(actor, id)));
  },
);

export const PATCH = withAuthenticatedRoute<{ departmentId: string }>(
  async (request: NextRequest, { params, actor, meta }) => {
    const id = objectIdSchema.parse(params.departmentId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = updateDepartmentSchema.parse(body);

    const department = await departmentService.update(
      actor,
      id,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.headUserId !== undefined ? { headUserId: input.headUserId } : {}),
        ...(input.storageQuotaGb !== undefined ? { storageQuotaGb: input.storageQuotaGb } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      meta,
    );

    return ok(toDepartmentDto(department));
  },
);

/** Deletion requires a stated reason — it is recorded in the audit trail. */
export const DELETE = withAuthenticatedRoute<{ departmentId: string }>(
  async (request: NextRequest, { params, actor, meta }) => {
    const id = objectIdSchema.parse(params.departmentId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = deleteDepartmentSchema.parse(body);

    await departmentService.remove(actor, id, input.reason, meta);
    return ok({ ok: true });
  },
);
