import type { NextRequest } from 'next/server';

import { NODE_ONLY_FEATURES, withNodeOnlyRoute } from '@/server/http/node-only';
import { noContent, ok } from '@/server/http/api-response';
import { toMigrationJobDto } from '@/server/http/dto';
import { migrationService } from '@/server/services/migration.service';
import { objectIdSchema } from '@/server/validation/common';
import { updateMigrationSchema } from '@/server/validation/migration.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withNodeOnlyRoute<{ jobId: string }>(NODE_ONLY_FEATURES.driveImport,
  async (_request, { actor, params }) => {
    const jobId = objectIdSchema.parse(params.jobId);
    return ok(toMigrationJobDto(await migrationService.getJob(actor, jobId)));
  },
);

export const PATCH = withNodeOnlyRoute<{ jobId: string }>(NODE_ONLY_FEATURES.driveImport,
  async (request: NextRequest, { actor, params, meta }) => {
    const jobId = objectIdSchema.parse(params.jobId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = updateMigrationSchema.parse(body);
    return ok(toMigrationJobDto(await migrationService.updateJob(actor, jobId, input, meta)));
  },
);

/**
 * Disconnects and archives the job. Files that were imported stay exactly where they are —
 * removing the record of a migration must not remove months of research.
 */
export const DELETE = withNodeOnlyRoute<{ jobId: string }>(NODE_ONLY_FEATURES.driveImport,
  async (_request, { actor, params, meta }) => {
    const jobId = objectIdSchema.parse(params.jobId);
    await migrationService.deleteJob(actor, jobId, meta);
    return noContent();
  },
);
