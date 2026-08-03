import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { migrationService } from '@/server/services/migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Walks the selected Drive folders and records what is there. Reads only — the Drive
 * client this reaches has no method capable of anything else.
 */
export const POST = withAuthenticatedRoute<{ jobId: string }>(
  async (_request, { actor, params, meta }) => {
    const jobId = objectIdSchema.parse(params.jobId);
    return ok(await migrationService.scan(actor, jobId, meta));
  },
);
