import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toFileDto, toFolderDto } from '@/server/http/dto';
import { searchService } from '@/server/services/search.service';
import { searchQuerySchema } from '@/server/validation/search.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Search across every drive the caller can reach.
 *
 * There is no "search this whole organization" mode and no administrator override:
 * results are always the intersection of the query and what this actor may open. An
 * administrator who needs to find a file they have no grant on grants themselves access
 * first — and that grant is audited, which searching around it would not be.
 */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const query = searchQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );

  const result = await searchService.search(actor, query);

  return ok(
    {
      files: result.files.map(toFileDto),
      folders: result.folders.map(toFolderDto),
      empty: result.empty,
    },
    {
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: result.totals.files + result.totals.folders,
        hasMore: result.totals.files > query.page * query.pageSize,
      },
    },
  );
});
