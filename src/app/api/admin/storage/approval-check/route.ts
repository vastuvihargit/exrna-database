import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { approvalIntegrityService } from '@/server/services/approval-integrity.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const sweepSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  /** Resume point from a previous run's `nextCursor`. */
  cursor: z.string().optional(),
});

/**
 * Re-checks approvals whose content lives in the Shared Drive.
 *
 * Answers one question per approval: is the document still the one that was signed off? Any
 * that is not goes back to needing review, its owner and its approver are told, and an audit
 * entry records what changed.
 *
 * Read-only for everything that is still correct — an approval that still matches is not
 * touched at all — so this is safe to run at any time and as often as you like. Normally
 * driven by the scheduler (`npm run drive:check-approvals`); this endpoint exists so an
 * administrator can check immediately, typically after being told a document was edited.
 *
 * `unavailable` in the result means Drive did not answer for that file. Those keep their
 * approval and are checked again next run — "we could not tell" is never recorded as "it is
 * fine".
 */
export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  assertCompanyPermission(actor, 'access.manage');

  const body: unknown = await request.json().catch(() => ({}));
  const input = sweepSchema.parse(body);

  return ok(
    await approvalIntegrityService.sweepRemoteApprovals({
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    }),
  );
});
