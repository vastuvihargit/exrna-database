import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toVersionDto } from '@/server/http/dto';
import { versionService } from '@/server/services/version.service';
import { objectIdSchema } from '@/server/validation/common';
import { updateVersionSchema } from '@/server/validation/file.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The note is the only writable field on a stored version; the model's immutability
 * hook rejects anything else, so there is no larger PATCH to accidentally widen this to.
 */
export const PATCH = withAuthenticatedRoute<{ fileId: string; versionId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const versionId = objectIdSchema.parse(params.versionId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = updateVersionSchema.parse(body);

    return ok(toVersionDto(await versionService.updateVersionNote(actor, fileId, versionId, input.note, meta)));
  },
);
