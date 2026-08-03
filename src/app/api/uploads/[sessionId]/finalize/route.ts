import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created } from '@/server/http/api-response';
import { uploadService } from '@/server/services/upload.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Step 3: turn the uploaded bytes into a file.
 *
 * Safe to call twice. A client that retries after a network timeout gets the result of
 * the first call rather than a second copy of the file — duplicate research data from a
 * retried request is exactly what the brief asks this endpoint to prevent.
 */
export const POST = withAuthenticatedRoute<{ sessionId: string }>(
  async (_request, { actor, params, meta }) => {
    const sessionId = objectIdSchema.parse(params.sessionId);
    const result = await uploadService.finalize(actor, sessionId, meta);
    return created(result);
  },
);
