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
 * Folder sharing. Identical rules to file sharing by design — a grant on a folder simply
 * reaches further, and the same guard against delegating what you do not hold applies.
 */
export const GET = withAuthenticatedRoute<{ folderId: string }>(
  async (_request, { actor, params }) => {
    const folderId = objectIdSchema.parse(params.folderId);
    return ok(toShareStateDto(await sharingService.getShareState(actor, 'folder', folderId)));
  },
);

export const POST = withAuthenticatedRoute<{ folderId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const folderId = objectIdSchema.parse(params.folderId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = shareGrantSchema.parse(body);

    return ok(
      toShareStateDto(
        await sharingService.share(
          actor,
          'folder',
          folderId,
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

export const DELETE = withAuthenticatedRoute<{ folderId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const folderId = objectIdSchema.parse(params.folderId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = revokeShareSchema.parse(body);

    return ok(
      toShareStateDto(
        await sharingService.revokeShare(
          actor,
          'folder',
          folderId,
          input.principalType,
          input.principalId,
          meta,
        ),
      ),
    );
  },
);
