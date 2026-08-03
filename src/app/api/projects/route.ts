import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created, ok } from '@/server/http/api-response';
import { toProjectDto } from '@/server/http/dto';
import { projectService } from '@/server/services/project.service';
import { createProjectSchema } from '@/server/validation/folder.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  const projects = await projectService.list(actor);
  return ok(projects.map(toProjectDto));
});

export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor, meta }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = createProjectSchema.parse(body);

  const project = await projectService.create(
    actor,
    {
      name: input.name,
      code: input.code,
      departmentId: input.departmentId,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.leadUserId !== undefined ? { leadUserId: input.leadUserId } : {}),
      ...(input.memberUserIds !== undefined ? { memberUserIds: input.memberUserIds } : {}),
      ...(input.confidentiality !== undefined ? { confidentiality: input.confidentiality } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(input.targetEndDate !== undefined ? { targetEndDate: input.targetEndDate } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    },
    meta,
  );

  return created(toProjectDto(project));
});
