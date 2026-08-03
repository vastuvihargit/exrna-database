import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { migrationService } from '@/server/services/migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Returns failed and stranded items to the queue so the next run picks them up. */
export const POST = withAuthenticatedRoute<{ jobId: string }>(
  async (_request, { actor, params, meta }) => {
    const jobId = objectIdSchema.parse(params.jobId);
    return ok(await migrationService.retryFailed(actor, jobId, meta));
  },
);
