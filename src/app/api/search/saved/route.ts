import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created, ok } from '@/server/http/api-response';
import { toSavedSearchDto } from '@/server/http/dto';
import * as savedSearchRepository from '@/server/repositories/saved-search.repository';
import { saveSearchSchema, searchQuerySchema } from '@/server/validation/search.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  const searches = await savedSearchRepository.listForUser(actor.userId);
  return ok(searches.map(toSavedSearchDto));
});

/**
 * Saves (or overwrites) a search by name.
 *
 * The criteria are re-parsed with the same schema the search endpoint uses before they
 * are stored. Without that, a saved search would be an unvalidated blob that gets fed
 * straight back into a query the next time it is opened.
 */
export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = saveSearchSchema.parse(body);

  const criteria = searchQuerySchema.parse(input.criteria);

  // Store the raw string form rather than the parsed one: dates and numbers come back
  // out of Mongo as their coerced types, and re-parsing a Date through a `YYYY-MM-DD`
  // string schema would fail. The strings are what the query string carried.
  const stored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.criteria)) {
    if (key in criteria) stored[key] = value;
  }

  const saved = await savedSearchRepository.upsert({
    organizationId: actor.organizationId,
    userId: actor.userId,
    name: input.name,
    criteria: stored,
    ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
  });

  return created(toSavedSearchDto(saved));
});
