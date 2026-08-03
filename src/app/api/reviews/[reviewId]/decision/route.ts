import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toReviewDto } from '@/server/http/dto';
import { reviewService } from '@/server/services/review.service';
import { objectIdSchema } from '@/server/validation/common';
import { decideReviewSchema } from '@/server/validation/review.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Records a decision against the exact version the request pinned.
 *
 * The service re-checks the version's checksum before accepting: signing bytes that are
 * no longer the bytes that were submitted would produce an approval record that means
 * nothing.
 */
export const POST = withAuthenticatedRoute<{ reviewId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const reviewId = objectIdSchema.parse(params.reviewId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = decideReviewSchema.parse(body);

    const review = await reviewService.decide(
      actor,
      reviewId,
      { decision: input.decision, ...(input.comment ? { comment: input.comment } : {}) },
      meta,
    );

    return ok(toReviewDto(review));
  },
);
