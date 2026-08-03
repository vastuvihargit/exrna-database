import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created, ok } from '@/server/http/api-response';
import { toReviewDto } from '@/server/http/dto';
import { reviewService } from '@/server/services/review.service';
import { objectIdSchema } from '@/server/validation/common';
import { submitReviewSchema } from '@/server/validation/review.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The file's full approval history, including withdrawn and rejected rounds. */
export const GET = withAuthenticatedRoute<{ fileId: string }>(
  async (_request, { actor, params }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const reviews = await reviewService.listForFile(actor, fileId);
    return ok(reviews.map(toReviewDto));
  },
);

/** Submits a specific version for review. Defaults to whatever is current. */
export const POST = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = submitReviewSchema.parse(body);

    const review = await reviewService.submitForReview(
      actor,
      fileId,
      {
        reviewerUserIds: input.reviewerUserIds,
        ...(input.note ? { note: input.note } : {}),
        ...(input.requiredApprovals ? { requiredApprovals: input.requiredApprovals } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
        ...(input.versionId ? { versionId: input.versionId } : {}),
      },
      meta,
    );

    return created(toReviewDto(review));
  },
);
