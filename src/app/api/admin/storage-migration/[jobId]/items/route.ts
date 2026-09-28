import type { NextRequest } from 'next/server';

import { NODE_ONLY_FEATURES, withNodeOnlyRoute } from '@/server/http/node-only';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { storageMigrationService } from '@/server/services/storage-migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The per-item table.
 *
 * `failedOnly=1` is the triage view an administrator actually wants: a completed job with
 * forty failures buried among ten thousand successes is not something anyone scrolls to.
 */
export const GET = withNodeOnlyRoute<{ jobId: string }>(NODE_ONLY_FEATURES.storageMigration,
  async (request: NextRequest, { actor, params }) => {
    assertCompanyPermission(actor, 'access.manage');
    const jobId = objectIdSchema.parse(params.jobId);
    const url = new URL(request.url);
    const afterId = url.searchParams.get('afterId');
    const limit = Number(url.searchParams.get('limit') ?? 100);

    return ok(
      await storageMigrationService.listJobItems(actor, jobId, {
        failedOnly: url.searchParams.get('failedOnly') === '1',
        limit: Number.isFinite(limit) ? limit : 100,
        ...(afterId ? { afterId } : {}),
      }),
    );
  },
);
