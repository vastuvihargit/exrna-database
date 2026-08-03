import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { storageMigrationService } from '@/server/services/storage-migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Planning walks the whole selection; a department-wide one is not instant. */
export const maxDuration = 300;

/**
 * Works out what the job would move, and reports the two hard external ceilings: the Shared
 * Drive item limit and Drive's 20-level folder depth.
 *
 * For a `dry_run` job this writes nothing at all — the report comes out of the same
 * selection code a real run uses, so it describes the migration that would actually happen
 * rather than an approximation of it.
 */
export const POST = withAuthenticatedRoute<{ jobId: string }>(
  async (_request, { actor, params, meta }) => {
    assertCompanyPermission(actor, 'access.manage');
    const jobId = objectIdSchema.parse(params.jobId);
    return ok(await storageMigrationService.planJobForActor(actor, jobId, meta));
  },
);
