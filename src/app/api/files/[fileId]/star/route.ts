import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { fileService } from '@/server/services/file.service';
import { objectIdSchema } from '@/server/validation/common';
import { starSchema } from '@/server/validation/folder.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const body: unknown = await request.json().catch(() => ({}));
    const { starred } = starSchema.parse(body);

    return ok(await fileService.setStarred(actor, fileId, starred));
  },
);
