import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created, ok } from '@/server/http/api-response';
import { toCommentDto } from '@/server/http/dto';
import { commentService } from '@/server/services/comment.service';
import { objectIdSchema } from '@/server/validation/common';
import { createCommentSchema, listCommentsQuerySchema } from '@/server/validation/sharing.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const query = listCommentsQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );

    const comments = await commentService.listComments(actor, fileId, query);
    return ok(comments.map(toCommentDto));
  },
);

/**
 * Commenting is allowed on an approved file.
 *
 * A comment cannot change the file — it is stored in a separate collection with no write
 * path into `File` — so the approved-file lock does not apply. Forbidding it would push
 * the discussion into email, where it stops being part of the record.
 */
export const POST = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = createCommentSchema.parse(body);

    const comment = await commentService.addComment(
      actor,
      fileId,
      {
        body: input.body,
        ...(input.parentCommentId ? { parentCommentId: input.parentCommentId } : {}),
        ...(input.versionId ? { versionId: input.versionId } : {}),
      },
      meta,
    );

    return created(toCommentDto(comment));
  },
);
