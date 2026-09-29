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
 * The body is piped straight into staging — never buffered beyond the 4 KB head the signature
 * check needs — so a multi-gigabyte upload costs the server a stream, not its heap. The staging
 * backend hashes and counts as it writes and aborts the moment the declared size is exceeded.
 *
 * `meta` is threaded through because a signature refusal now happens *here* rather than at
 * finalization, and it is audited.
 */
export const PUT = withAuthenticatedRoute<{ sessionId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const sessionId = objectIdSchema.parse(params.sessionId);
    const result = await uploadService.receiveStream(
      actor,
      sessionId,
      nodeStreamFromRequest(request),
      meta,
    );
    return ok(result);
  },
);
