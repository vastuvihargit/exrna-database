import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { folderService } from '@/server/services/folder.service';
import { objectIdSchema } from '@/server/validation/common';
import { starSchema } from '@/server/validation/folder.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Stars are per-viewer, so this needs no permission beyond being able to see the folder. */
export const PUT = withAuthenticatedRoute<{ folderId: string }>(
  async (request: NextRequest, { actor, params }) => {
    const folderId = objectIdSchema.parse(params.folderId);
    const body: unknown = await request.json().catch(() => ({}));
    const { starred } = starSchema.parse(body);

    return ok(await folderService.setStarred(actor, folderId, starred));
  },
);
