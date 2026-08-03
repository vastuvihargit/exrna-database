import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toShareStateDto } from '@/server/http/dto';
import { sharingService } from '@/server/services/sharing.service';
import { objectIdSchema } from '@/server/validation/common';
import { setInheritanceSchema } from '@/server/validation/sharing.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Breaks or restores folder inheritance for one file.
 *
 * `access.manage`, not `share.internal` — breaking inheritance removes access from people
 * who are not named anywhere in this request, which is a different kind of act from
 * handing something to a named colleague.
 */
export const PUT = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const body: unknown = await request.json().catch(() => ({}));
    const { inherit } = setInheritanceSchema.parse(body);

    return ok(
      toShareStateDto(await sharingService.setInheritance(actor, 'file', fileId, inherit, meta)),
    );
  },
);
