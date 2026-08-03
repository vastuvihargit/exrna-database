import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toProjectDto } from '@/server/http/dto';
import { projectService } from '@/server/services/project.service';
import { objectIdSchema } from '@/server/validation/common';
import { updateProjectSchema } from '@/server/validation/folder.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute<{ projectId: string }>(
  async (_request, { actor, params }) => {
    const projectId = objectIdSchema.parse(params.projectId);
    return ok(toProjectDto(await projectService.getById(actor, projectId)));
  },
);

export const PATCH = withAuthenticatedRoute<{ projectId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const projectId = objectIdSchema.parse(params.projectId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = updateProjectSchema.parse(body);

    const project = await projectService.update(actor, projectId, input, meta);
    return ok(toProjectDto(project));
  },
);
