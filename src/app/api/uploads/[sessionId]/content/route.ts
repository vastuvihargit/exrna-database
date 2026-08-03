import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { nodeStreamFromRequest } from '@/server/http/request-stream';
import { uploadService } from '@/server/services/upload.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Uploads are long-running by nature; the platform default would cut large ones off. */
export const maxDuration = 300;

/**
 * Step 2: the bytes.
 *
 * The body is piped straight into quarantine — never buffered — so a multi-gigabyte
 * upload costs the server a stream, not its heap. The provider hashes and counts as it
 * writes and aborts the moment the declared size is exceeded.
 */
export const PUT = withAuthenticatedRoute<{ sessionId: string }>(
  async (request: NextRequest, { actor, params }) => {
    const sessionId = objectIdSchema.parse(params.sessionId);
    const result = await uploadService.receiveStream(
      actor,
      sessionId,
      nodeStreamFromRequest(request),
    );
    return ok(result);
  },
);
