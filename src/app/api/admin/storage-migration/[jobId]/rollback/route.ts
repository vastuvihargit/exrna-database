import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { storageMigrationService } from '@/server/services/storage-migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Reverts migrated versions to reading from their retained local copies.
 *
 * A field flip: no bytes move, and the Drive objects are deliberately left in place —
 * deleting them would make the rollback itself the destructive act. Any version whose local
 * copy has already been deleted is skipped rather than pointed at bytes that are not there,
 * and the audit entry for a rollback with skips is raised to critical.
 */
export const POST = withAuthenticatedRoute<{ jobId: string }>(
  async (_request, { actor, params, meta }) => {
    assertCompanyPermission(actor, 'access.manage');
    const jobId = objectIdSchema.parse(params.jobId);
    return ok(await storageMigrationService.rollbackJobForActor(actor, jobId, meta));
  },
);
