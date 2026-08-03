import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { storageMigrationService } from '@/server/services/storage-migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const runSchema = z.object({
  /**
   * Bounds the batch so one request cannot outlive the platform ceiling. Resuming is just
   * calling this again: a job has no notion of "the run that owns it", which is the same
   * property that lets it survive the process dying mid-batch.
   */
  maxItems: z.number().int().min(1).max(500).optional(),
  retryFailed: z.boolean().optional(),
});

export const POST = withAuthenticatedRoute<{ jobId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    assertCompanyPermission(actor, 'access.manage');
    const jobId = objectIdSchema.parse(params.jobId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = runSchema.parse(body);

    return ok(await storageMigrationService.runJobForActor(actor, jobId, meta, input));
  },
);
