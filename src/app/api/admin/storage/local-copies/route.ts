import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { NODE_ONLY_FEATURES, withNodeOnlyRoute } from '@/server/http/node-only';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { localCopyService } from '@/server/services/storage-migration/local-copies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const sweepSchema = z.object({
  action: z.enum(['archive', 'delete']),
  limit: z.number().int().min(1).max(500).optional(),
  /**
   * Defaults to **true**. The only destructive endpoint in this application whose safe mode
   * is the default — a mistyped request here removes the last copy of somebody's data, and
   * the cost of an extra round trip is nothing against that.
   */
  dryRun: z.boolean().optional(),
});

/**
 * What the retained local copies are holding, and what is now eligible to be cleaned up.
 *
 * Read-only, and the natural first call: an administrator deciding whether to archive needs
 * to know how much disk it would return before deciding anything.
 */
export const GET = withNodeOnlyRoute(NODE_ONLY_FEATURES.localCopies, async (_request: NextRequest, { actor }) => {
  assertCompanyPermission(actor, 'access.manage');
  const [summary, candidates] = await Promise.all([
    localCopyService.summarizeLocalCopies(),
    localCopyService.listCandidates({ action: 'archive', limit: 20 }),
  ]);
  return ok({
    ...summary,
    // A sample, not the list. The point is to show what kind of thing is eligible, not to
    // become another file browser with different disclosure rules.
    sample: candidates.map((item) => ({
      fileId: item.fileId,
      versionNumber: item.versionNumber,
      sizeBytes: item.sizeBytes,
      eligibleAt: item.eligibleAt,
    })),
  });
});

/**
 * Archives or deletes retained local copies.
 *
 * **Archive** moves the bytes aside into the archive area. Nothing is lost, rollback still
 * works, and most of the disk comes back. This is the one to reach for.
 *
 * **Delete** removes them, and with them the ability to roll that version back to local
 * storage and the ability to serve it if its Drive object ever goes missing. It additionally
 * requires `DELETE_LOCAL_AFTER_MIGRATION=true`, and each file is checked against Drive at the
 * moment of deletion rather than trusted to a `verified` flag set weeks ago.
 *
 * Never scheduled, never a side effect of anything else. §18 of the brief asks for exactly
 * that, and the reason is that this is the only irreversible step in the whole migration.
 */
export const POST = withNodeOnlyRoute(NODE_ONLY_FEATURES.localCopies, async (request: NextRequest, { actor, meta }) => {
  assertCompanyPermission(actor, 'access.manage');

  const body: unknown = await request.json().catch(() => ({}));
  const input = sweepSchema.parse(body);

  return ok(
    await localCopyService.sweepLocalCopies({
      action: input.action,
      dryRun: input.dryRun !== false,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      audit: { actor, meta },
    }),
  );
});
