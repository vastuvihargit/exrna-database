import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toShareStateDto } from '@/server/http/dto';
import { sharingService } from '@/server/services/sharing.service';
import { objectIdSchema } from '@/server/validation/common';
import { setInheritanceSchema } from '@/server/validation/sharing.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = withAuthenticatedRoute<{ folderId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const folderId = objectIdSchema.parse(params.folderId);
    const body: unknown = await request.json().catch(() => ({}));
    const { inherit } = setInheritanceSchema.parse(body);

    return ok(
      toShareStateDto(await sharingService.setInheritance(actor, 'folder', folderId, inherit, meta)),
    );
  },
);
