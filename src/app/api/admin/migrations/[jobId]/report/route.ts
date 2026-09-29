import { NODE_ONLY_FEATURES, withNodeOnlyRoute } from '@/server/http/node-only';
import { ok } from '@/server/http/api-response';
import { toMigrationItemDto, toMigrationJobDto } from '@/server/http/dto';
import { migrationService } from '@/server/services/migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Counts by outcome plus the rows that need a human decision. */
export const GET = withNodeOnlyRoute<{ jobId: string }>(NODE_ONLY_FEATURES.driveImport,
  async (_request, { actor, params }) => {
    const jobId = objectIdSchema.parse(params.jobId);
    const report = await migrationService.report(actor, jobId);

    return ok({
      job: toMigrationJobDto(report.job),
      byStatus: report.byStatus,
      attention: report.attention.map(toMigrationItemDto),
    });
  },
);
