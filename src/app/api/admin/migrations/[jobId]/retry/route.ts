import { NODE_ONLY_FEATURES, withNodeOnlyRoute } from '@/server/http/node-only';
import { ok } from '@/server/http/api-response';
import { migrationService } from '@/server/services/migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Returns failed and stranded items to the queue so the next run picks them up. */
export const POST = withNodeOnlyRoute<{ jobId: string }>(NODE_ONLY_FEATURES.driveImport,
  async (_request, { actor, params, meta }) => {
    const jobId = objectIdSchema.parse(params.jobId);
    return ok(await migrationService.retryFailed(actor, jobId, meta));
  },
);
