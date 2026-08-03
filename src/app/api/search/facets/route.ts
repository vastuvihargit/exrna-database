import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { searchService } from '@/server/services/search.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Filter chips with counts.
 *
 * Computed over the caller's visible set, not the whole organization — a facet count is
 * a disclosure too. "restricted (4)" tells you four restricted files exist even when
 * none of them can be opened.
 */
export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  return ok(await searchService.facets(actor));
});
