import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toFolderDto } from '@/server/http/dto';
import { folderService } from '@/server/services/folder.service';
import { objectIdSchema } from '@/server/validation/common';
import { renameFolderSchema } from '@/server/validation/folder.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuthenticatedRoute<{ folderId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const folderId = objectIdSchema.parse(params.folderId);
    const body: unknown = await request.json().catch(() => ({}));
    const { name } = renameFolderSchema.parse(body);

    const folder = await folderService.renameFolder(actor, folderId, name, meta);
    return ok(toFolderDto(folder));
  },
);
