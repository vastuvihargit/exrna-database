import { z } from 'zod';
import { objectIdSchema, paginationSchema } from './common';
import { REVIEW_DECISIONS } from '@/server/db/models/review.model';

export const submitReviewSchema = z.object({
  reviewerUserIds: z.array(objectIdSchema).min(1).max(10),
  note: z.string().trim().max(2000).optional(),
  /**
   * Capped at the number of reviewers by the service — a request needing three
   * approvals from two reviewers could never close.
   */
  requiredApprovals: z.number().int().min(1).max(10).optional(),
  dueAt: z
    .string()
    .datetime()
    .transform((value) => new Date(value))
    .nullable()
    .optional(),
  versionId: objectIdSchema.optional(),
});

/**
 * A comment is required when asking for changes or rejecting.
 *
 * "Rejected" with no reason is an unanswerable message: the submitter cannot act on it,
 * and the audit record it produces explains nothing to whoever reads it later.
 */
export const decideReviewSchema = z
  .object({
    decision: z.enum(REVIEW_DECISIONS),
    comment: z.string().trim().max(2000).optional(),
  })
  .refine(
    (value) => value.decision === 'approve' || Boolean(value.comment?.trim()),
    { message: 'Explain what needs to change', path: ['comment'] },
  );

export const listReviewsQuerySchema = paginationSchema.extend({
  scope: z.enum(['assigned', 'submitted']).default('assigned'),
});
