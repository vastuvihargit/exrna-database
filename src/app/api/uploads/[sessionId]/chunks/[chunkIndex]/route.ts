import type { NextRequest } from 'next/server';

import { getEnv } from '@/server/config/env';
import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { readBoundedBody } from '@/server/http/request-stream';
import { uploadService } from '@/server/services/upload.service';
import { objectIdSchema } from '@/server/validation/common';
import { chunkParamsSchema } from '@/server/validation/file.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * One chunk of a resumable upload.
 *
 * A chunk is bounded by the size agreed when the session was created, so reading it
 * into memory is safe — unlike the whole file, which is always streamed. Re-sending a
 * chunk after a dropped connection is expected and does not double-count.
 */
export const PUT = withAuthenticatedRoute<{ sessionId: string; chunkIndex: string }>(
  async (request: NextRequest, { actor, params }) => {
    const sessionId = objectIdSchema.parse(params.sessionId);
    const { chunkIndex } = chunkParamsSchema.parse({ chunkIndex: params.chunkIndex });

    const chunk = await readBoundedBody(request, getEnv().uploadChunkBytes);
    const result = await uploadService.receiveChunk(actor, sessionId, chunkIndex, chunk);

    return ok(result);
  },
);
