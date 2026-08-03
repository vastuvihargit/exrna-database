import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { noContent, ok } from '@/server/http/api-response';
import { toFileDto } from '@/server/http/dto';
import { fileService } from '@/server/services/file.service';
import { objectIdSchema } from '@/server/validation/common';
import { updateFileSchema } from '@/server/validation/file.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute<{ fileId: string }>(
  async (_request, { actor, params }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    return ok(toFileDto(await fileService.getFile(actor, fileId)));
  },
);

export const PATCH = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = updateFileSchema.parse(body);

    return ok(toFileDto(await fileService.updateFile(actor, fileId, input, meta)));
  },
);

/** Moves the file to the trash. The stored bytes stay until the retention window ends. */
export const DELETE = withAuthenticatedRoute<{ fileId: string }>(
  async (_request, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    await fileService.trashFile(actor, fileId, meta);
    return noContent();
  },
);
