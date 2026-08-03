import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { storageMigrationService } from '@/server/services/storage-migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Requests a pause.
 *
 * The running worker stops at the next item boundary rather than tearing a transfer in
 * half, so this returns immediately and the job settles a moment later. Interrupting a live
 * upload to honour the pause a few seconds sooner would leave a partial object and an open
 * recovery row for no benefit.
 */
export const POST = withAuthenticatedRoute<{ jobId: string }>(
  async (_request, { actor, params, meta }) => {
    assertCompanyPermission(actor, 'access.manage');
    const jobId = objectIdSchema.parse(params.jobId);
    await storageMigrationService.pauseJob(actor, jobId, meta);
    return ok({ pauseRequested: true });
  },
);
