import { NODE_ONLY_FEATURES, withNodeOnlyRoute } from '@/server/http/node-only';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { storageMigrationService } from '@/server/services/storage-migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Requeues failed items so the next run can claim them.
 *
 * Retrying never duplicates: a transfer whose object already reached Drive is adopted by
 * its idempotency key rather than uploaded again, and the unique index on the version's
 * Drive id refuses a second one regardless.
 */
export const POST = withNodeOnlyRoute<{ jobId: string }>(NODE_ONLY_FEATURES.storageMigration,
  async (_request, { actor, params, meta }) => {
    assertCompanyPermission(actor, 'access.manage');
    const jobId = objectIdSchema.parse(params.jobId);
    return ok(await storageMigrationService.retryFailed(actor, jobId, meta));
  },
);
