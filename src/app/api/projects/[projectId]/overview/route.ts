import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toActivityDto, toExperimentDto, toProjectDto } from '@/server/http/dto';
import { projectService } from '@/server/services/project.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The project dashboard.
 *
 * Every count is computed over the caller's visible set, so two members of the same
 * project can see different totals — which is correct. A single organization-wide number
 * would tell a viewer precisely how much of the project is being kept from them.
 */
export const GET = withAuthenticatedRoute<{ projectId: string }>(
  async (_request, { actor, params }) => {
    const projectId = objectIdSchema.parse(params.projectId);
    const overview = await projectService.overview(actor, projectId);

    return ok({
      project: toProjectDto(overview.project),
      department: overview.department,
      members: overview.members,
      content: overview.content,
      experiments: overview.experiments,
      recentExperiments: overview.recentExperiments.map(toExperimentDto),
      activity: overview.activity.map(toActivityDto),
      missingTemplateFolders: overview.missingTemplateFolders,
    });
  },
);
