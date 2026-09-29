import { NODE_ONLY_FEATURES, withNodeOnlyRoute } from '@/server/http/node-only';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { storageMigrationService } from '@/server/services/storage-migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Re-checks migrated objects against Drive.
 *
 * Metadata reads only, no bytes — cheap enough to run over a whole migrated corpus before
 * authorising any local deletion, which is the point at which being wrong stops being
 * recoverable.
 */
export const POST = withNodeOnlyRoute<{ jobId: string }>(NODE_ONLY_FEATURES.storageMigration,
  async (_request, { actor, params, meta }) => {
    assertCompanyPermission(actor, 'access.manage');
    const jobId = objectIdSchema.parse(params.jobId);
    return ok(await storageMigrationService.verifyJobForActor(actor, jobId, meta));
  },
);
