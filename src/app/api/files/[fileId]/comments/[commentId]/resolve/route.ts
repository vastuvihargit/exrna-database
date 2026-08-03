import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toCommentDto } from '@/server/http/dto';
import { commentService } from '@/server/services/comment.service';
import { objectIdSchema } from '@/server/validation/common';
import { resolveCommentSchema } from '@/server/validation/sharing.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolving hides a thread from the default view without deleting it — the record of
 * what was raised, and that it was addressed, stays part of the file's history.
 */
export const PUT = withAuthenticatedRoute<{ fileId: string; commentId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const commentId = objectIdSchema.parse(params.commentId);
    const body: unknown = await request.json().catch(() => ({}));
    const { resolved } = resolveCommentSchema.parse(body);

    const comment = await commentService.setResolved(actor, fileId, commentId, resolved, meta);
    return ok(
      toCommentDto({
        ...comment,
        replies: [],
        capabilities: { canEdit: false, canDelete: false, canResolve: true },
      }),
    );
  },
);
