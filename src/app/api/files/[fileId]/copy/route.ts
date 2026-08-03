import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created } from '@/server/http/api-response';
import { toFileDto } from '@/server/http/dto';
import { fileService } from '@/server/services/file.service';
import { objectIdSchema } from '@/server/validation/common';
import { copyFileSchema } from '@/server/validation/file.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const body: unknown = await request.json().catch(() => ({}));
    const { targetFolderId } = copyFileSchema.parse(body);

    return created(toFileDto(await fileService.copyFile(actor, fileId, targetFolderId, meta)));
  },
);
