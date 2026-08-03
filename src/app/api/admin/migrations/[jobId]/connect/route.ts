import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { ConflictError } from '@/server/errors/app-error';
import { toMigrationJobDto } from '@/server/http/dto';
import { migrationService } from '@/server/services/migration.service';
import { objectIdSchema } from '@/server/validation/common';
import { completeConnectSchema } from '@/server/validation/migration.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Starts the Drive consent flow and returns the URL to send the administrator to.
 *
 * The URL is returned rather than redirected to, so the caller can show what is about to
 * happen — connecting an account that can read an entire Google Drive is not something to
 * do behind a silent 302.
 */
export const GET = withAuthenticatedRoute<{ jobId: string }>(
  async (_request, { actor, params }) => {
    const jobId = objectIdSchema.parse(params.jobId);
    return ok(await migrationService.beginConnect(actor, jobId));
  },
);

/**
 * Completes the flow with the code Google handed back.
 *
 * `state` is echoed by the client and must name this job. It is a binding check, not the
 * authorization: the service re-derives the actor's permission on the job regardless.
 */
export const POST = withAuthenticatedRoute<{ jobId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const jobId = objectIdSchema.parse(params.jobId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = completeConnectSchema.parse(body);

    if (!input.state.startsWith(`${jobId}:`)) {
      // The consent round-trip came back naming a different job than the one being
      // connected. Refuse rather than guess which is right — the wrong answer would
      // attach a Drive credential to a migration nobody authorized it for.
      throw new ConflictError('This authorization does not belong to this migration');
    }

    const job = await migrationService.completeConnect(actor, { jobId, code: input.code }, meta);
    return ok(toMigrationJobDto(job));
  },
);
