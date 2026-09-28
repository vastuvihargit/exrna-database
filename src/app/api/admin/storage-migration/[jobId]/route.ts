import { NODE_ONLY_FEATURES, withNodeOnlyRoute } from '@/server/http/node-only';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { storageMigrationService } from '@/server/services/storage-migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Job detail plus live item counts — everything the dashboard header needs in one call. */
export const GET = withNodeOnlyRoute<{ jobId: string }>(NODE_ONLY_FEATURES.storageMigration, async (_request, { actor, params }) => {
  assertCompanyPermission(actor, 'access.manage');
  const jobId = objectIdSchema.parse(params.jobId);
  return ok(await storageMigrationService.getJobDetail(actor, jobId));
});
