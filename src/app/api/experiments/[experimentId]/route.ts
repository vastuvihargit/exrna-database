import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { noContent, ok } from '@/server/http/api-response';
import { toExperimentDto } from '@/server/http/dto';
import { experimentService } from '@/server/services/experiment.service';
import { objectIdSchema } from '@/server/validation/common';
import { updateExperimentSchema } from '@/server/validation/experiment.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute<{ experimentId: string }>(
  async (_request, { actor, params }) => {
    const experimentId = objectIdSchema.parse(params.experimentId);
    return ok(toExperimentDto(await experimentService.getById(actor, experimentId)));
  },
);

export const PATCH = withAuthenticatedRoute<{ experimentId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const experimentId = objectIdSchema.parse(params.experimentId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = updateExperimentSchema.parse(body);

    return ok(toExperimentDto(await experimentService.update(actor, experimentId, input, meta)));
  },
);

/**
 * Archives the experiment. Files that pointed at it keep pointing at it — the record of
 * what produced a dataset outlives the decision to stop listing the experiment.
 */
export const DELETE = withAuthenticatedRoute<{ experimentId: string }>(
  async (_request, { actor, params, meta }) => {
    const experimentId = objectIdSchema.parse(params.experimentId);
    await experimentService.archive(actor, experimentId, meta);
    return noContent();
  },
);
