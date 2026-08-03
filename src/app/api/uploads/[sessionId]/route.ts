import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { noContent, ok } from '@/server/http/api-response';
import { uploadService } from '@/server/services/upload.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Progress for a resumable upload: which chunks the server already holds. */
export const GET = withAuthenticatedRoute<{ sessionId: string }>(
  async (_request, { actor, params }) => {
    const sessionId = objectIdSchema.parse(params.sessionId);
    const session = await uploadService.getStatus(actor, sessionId);

    return ok({
      sessionId: session.id,
      status: session.status,
      displayName: session.displayName,
      declaredSize: session.declaredSize,
      receivedBytes: session.receivedBytes,
      chunkSize: session.chunkSize,
      totalChunks: session.totalChunks,
      receivedChunks: session.receivedChunks,
      expiresAt: session.expiresAt,
      failureReason: session.failureReason,
      resultFileId: session.resultFileId,
    });
  },
);

/** Cancels an upload and removes whatever bytes it had already accepted. */
export const DELETE = withAuthenticatedRoute<{ sessionId: string }>(
  async (_request, { actor, params }) => {
    const sessionId = objectIdSchema.parse(params.sessionId);
    await uploadService.abort(actor, sessionId);
    return noContent();
  },
);
