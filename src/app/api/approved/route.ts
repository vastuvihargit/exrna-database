import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toFileDto } from '@/server/http/dto';
import { searchService } from '@/server/services/search.service';
import { paginationSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Approved files.
 *
 * Implemented as a search rather than its own query so it inherits the permission
 * filtering, the second authorization pass and the honest totals for free — an
 * "approved files" list with its own bespoke query would be a second place for the
 * visibility rules to drift out of step.
 */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const page = paginationSchema.parse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );

  const result = await searchService.search(actor, {
    ...page,
    scope: 'files',
    approvalStatus: 'approved',
    includeArchived: false,
    sort: 'updatedAt',
    order: 'desc',
  } as Parameters<typeof searchService.search>[1]);

  return ok(
    { files: result.files.map(toFileDto) },
    { meta: { page: page.page, pageSize: page.pageSize, total: result.totals.files } },
  );
});
