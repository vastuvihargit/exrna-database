import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toMigrationJobDto } from '@/server/http/dto';
import { migrationService } from '@/server/services/migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Pauses the migration.
 *
 * A running batch re-reads the job before every file, so this takes effect within one
 * file rather than at the end of a batch — and the item currently in flight either
 * finishes cleanly or is left claimable by a retry. Nothing half-imported survives.
 */
export const POST = withAuthenticatedRoute<{ jobId: string }>(
  async (_request, { actor, params, meta }) => {
    const jobId = objectIdSchema.parse(params.jobId);
    return ok(toMigrationJobDto(await migrationService.pause(actor, jobId, meta)));
  },
);
