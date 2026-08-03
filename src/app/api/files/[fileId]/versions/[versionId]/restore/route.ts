import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created } from '@/server/http/api-response';
import { toVersionDto } from '@/server/http/dto';
import { versionService } from '@/server/services/version.service';
import { objectIdSchema } from '@/server/validation/common';
import { restoreVersionSchema } from '@/server/validation/file.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Restores an older version — by appending it as a new one.
 *
 * 201, not 200: this creates a resource. The response is the *new* version, and the
 * version the caller named is untouched and still in the history.
 */
export const POST = withAuthenticatedRoute<{ fileId: string; versionId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const versionId = objectIdSchema.parse(params.versionId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = restoreVersionSchema.parse(body);

    const version = await versionService.restoreVersion(
      actor,
      fileId,
      { versionId, ...(input.note !== undefined ? { note: input.note } : {}) },
      meta,
    );

    return created(toVersionDto(version));
  },
);
