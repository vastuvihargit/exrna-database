import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { noContent, ok } from '@/server/http/api-response';
import { toCommentDto } from '@/server/http/dto';
import { commentService } from '@/server/services/comment.service';
import { objectIdSchema } from '@/server/validation/common';
import { editCommentSchema } from '@/server/validation/sharing.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Only the author may edit — a rewritten comment would make the record untrustworthy. */
export const PATCH = withAuthenticatedRoute<{ fileId: string; commentId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const commentId = objectIdSchema.parse(params.commentId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = editCommentSchema.parse(body);

    const comment = await commentService.editComment(actor, fileId, commentId, input.body, meta);
    return ok(toCommentDto({ ...comment, replies: [], capabilities: { canEdit: true, canDelete: true, canResolve: true } }));
  },
);

export const DELETE = withAuthenticatedRoute<{ fileId: string; commentId: string }>(
  async (_request, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const commentId = objectIdSchema.parse(params.commentId);
    await commentService.deleteComment(actor, fileId, commentId, meta);
    return noContent();
  },
);
