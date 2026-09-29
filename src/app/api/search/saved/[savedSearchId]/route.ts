import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { noContent, ok } from '@/server/http/api-response';
import { detach } from '@/server/runtime/detach';
import { toSavedSearchDto } from '@/server/http/dto';
import { NotFoundError } from '@/server/errors/app-error';
import * as savedSearchRepository from '@/server/repositories/saved-search.repository';
import { objectIdSchema } from '@/server/validation/common';
import { updateSavedSearchSchema } from '@/server/validation/search.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Every handler here is scoped by `actor.userId` at the repository level, so another
 * user's saved-search id resolves to nothing rather than to a 403 — which would confirm
 * it exists.
 */
export const GET = withAuthenticatedRoute<{ savedSearchId: string }>(
  async (_request, { actor, params }) => {
    const id = objectIdSchema.parse(params.savedSearchId);
    const saved = await savedSearchRepository.findOwned(actor.userId, id);
    if (!saved) throw new NotFoundError();

    detach(savedSearchRepository.markRun(actor.userId, id), 'savedSearch.markRun');
    return ok(toSavedSearchDto(saved));
  },
);

export const PATCH = withAuthenticatedRoute<{ savedSearchId: string }>(
  async (request: NextRequest, { actor, params }) => {
    const id = objectIdSchema.parse(params.savedSearchId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = updateSavedSearchSchema.parse(body);

    const updated = await savedSearchRepository.update(actor.userId, id, input);
    if (!updated) throw new NotFoundError();
    return ok(toSavedSearchDto(updated));
  },
);

export const DELETE = withAuthenticatedRoute<{ savedSearchId: string }>(
  async (_request, { actor, params }) => {
    const id = objectIdSchema.parse(params.savedSearchId);
    const removed = await savedSearchRepository.remove(actor.userId, id);
    if (!removed) throw new NotFoundError();
    return noContent();
  },
);
