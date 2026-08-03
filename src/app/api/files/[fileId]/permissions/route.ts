import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toShareStateDto } from '@/server/http/dto';
import { sharingService } from '@/server/services/sharing.service';
import { objectIdSchema } from '@/server/validation/common';
import { revokeShareSchema, shareGrantSchema } from '@/server/validation/sharing.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who this file is shared with.
 *
 * Requires `share.internal`, not merely view: the list names colleagues and implies what
 * they work on, which is more than "you may read this file" entitles someone to know.
 */
export const GET = withAuthenticatedRoute<{ fileId: string }>(
  async (_request, { actor, params }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    return ok(toShareStateDto(await sharingService.getShareState(actor, 'file', fileId)));
  },
);

export const POST = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = shareGrantSchema.parse(body);

    return ok(
      toShareStateDto(
        await sharingService.share(
          actor,
          'file',
          fileId,
          {
            principalType: input.principalType,
            principalId: input.principalId,
            accessLevel: input.accessLevel,
            ...(input.deny !== undefined ? { deny: input.deny } : {}),
            ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          },
          meta,
        ),
      ),
    );
  },
);

/**
 * Revocation takes effect on the next request, with nothing to invalidate: the Actor is
 * rebuilt per request and ACLs are read from the document on every decision.
 */
export const DELETE = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = revokeShareSchema.parse(body);

    return ok(
      toShareStateDto(
        await sharingService.revokeShare(
          actor,
          'file',
          fileId,
          input.principalType,
          input.principalId,
          meta,
        ),
      ),
    );
  },
);
