import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toFileDto } from '@/server/http/dto';
import { fileService } from '@/server/services/file.service';
import { objectIdSchema } from '@/server/validation/common';
import { moveFileSchema } from '@/server/validation/file.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const body: unknown = await request.json().catch(() => ({}));
    const { targetFolderId } = moveFileSchema.parse(body);

    return ok(toFileDto(await fileService.moveFile(actor, fileId, targetFolderId, meta)));
  },
);
