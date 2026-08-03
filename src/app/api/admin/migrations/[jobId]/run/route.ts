import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { migrationService } from '@/server/services/migration.service';
import { objectIdSchema } from '@/server/validation/common';
import { runImportSchema } from '@/server/validation/migration.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Imports a bounded batch of pending items and reports what is left.
 *
 * Bounded deliberately: a handler that imported forty thousand files would hold one
 * connection open for hours and lose everything to a single timeout. The client calls
 * this repeatedly, and any call can be the last one without losing work.
 */
export const POST = withAuthenticatedRoute<{ jobId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const jobId = objectIdSchema.parse(params.jobId);
    const body: unknown = await request.json().catch(() => ({}));
    const { limit } = runImportSchema.parse(body);

    return ok(
      await migrationService.runImport(actor, jobId, meta, limit !== undefined ? { limit } : {}),
    );
  },
);
