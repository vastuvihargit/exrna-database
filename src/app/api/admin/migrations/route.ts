import type { NextRequest } from 'next/server';

import { NODE_ONLY_FEATURES, withNodeOnlyRoute } from '@/server/http/node-only';
import { created, ok } from '@/server/http/api-response';
import { toMigrationJobDto } from '@/server/http/dto';
import { migrationService } from '@/server/services/migration.service';
import { createMigrationSchema } from '@/server/validation/migration.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Migration jobs.
 *
 * Company-scoped `access.manage` throughout, asserted in the service: a migration
 * connects an external account that can read an entire Google Drive and writes its
 * contents into this platform. It is not a department-level action.
 */
export const GET = withNodeOnlyRoute(NODE_ONLY_FEATURES.driveImport, async (_request, { actor }) => {
  const jobs = await migrationService.listJobs(actor);
  return ok(jobs.map(toMigrationJobDto));
});

export const POST = withNodeOnlyRoute(NODE_ONLY_FEATURES.driveImport, async (request: NextRequest, { actor, meta }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = createMigrationSchema.parse(body);
  const job = await migrationService.createJob(actor, input, meta);
  return created(toMigrationJobDto(job));
});
