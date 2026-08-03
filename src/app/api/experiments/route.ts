import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created, ok } from '@/server/http/api-response';
import { toExperimentDto } from '@/server/http/dto';
import { experimentService } from '@/server/services/experiment.service';
import {
  createExperimentSchema,
  listExperimentsSchema,
} from '@/server/validation/experiment.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Experiments the caller can reach.
 *
 * Scoped to the projects they can see before the query runs — an experiment code and
 * title describe research, and listing them for a project someone has no part in would
 * disclose what that project is working on without opening a single file.
 */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const query = listExperimentsSchema.parse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );

  const { items, total } = await experimentService.list(actor, query);

  return ok(items.map(toExperimentDto), {
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasMore: total > query.page * query.pageSize,
    },
  });
});

export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor, meta }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = createExperimentSchema.parse(body);

  const experiment = await experimentService.create(actor, input, meta);
  return created(toExperimentDto(experiment));
});
