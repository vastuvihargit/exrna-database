import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toReviewDto } from '@/server/http/dto';
import { reviewService } from '@/server/services/review.service';
import { listReviewsQuerySchema } from '@/server/validation/review.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The pending-review dashboard.
 *
 * `assigned` is what is waiting on the caller; `submitted` is what they are waiting on.
 * Both are re-filtered by file visibility in the service, so a request naming a file
 * whose access was later revoked disappears from the list rather than leaking its name.
 */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const query = listReviewsQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );

  const { items, total } =
    query.scope === 'submitted'
      ? await reviewService.listMySubmissions(actor, query)
      : await reviewService.listPendingForMe(actor, query);

  return ok(items.map(toReviewDto), {
    meta: { page: query.page, pageSize: query.pageSize, total },
  });
});
