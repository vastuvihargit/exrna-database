import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { noContent } from '@/server/http/api-response';
import { reviewService } from '@/server/services/review.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Withdraws a review request.
 *
 * The request is marked `cancelled`, never removed: the fact that a review was raised
 * and then withdrawn is part of the file's history, and deleting it would make the
 * approval trail incomplete in exactly the way an auditor would ask about.
 */
export const DELETE = withAuthenticatedRoute<{ reviewId: string }>(
  async (_request, { actor, params, meta }) => {
    const reviewId = objectIdSchema.parse(params.reviewId);
    await reviewService.cancelReview(actor, reviewId, meta);
    return noContent();
  },
);
