import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toBreadcrumbDto, toFolderDto } from '@/server/http/dto';
import { folderService } from '@/server/services/folder.service';
import { objectIdSchema } from '@/server/validation/common';
import { updateFolderSchema } from '@/server/validation/folder.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute<{ folderId: string }>(
  async (_request, { actor, params }) => {
    const folderId = objectIdSchema.parse(params.folderId);
    const result = await folderService.getFolder(actor, folderId);
    return ok({
      folder: toFolderDto(result.folder),
      breadcrumbs: result.breadcrumbs.map(toBreadcrumbDto),
    });
  },
);

export const PATCH = withAuthenticatedRoute<{ folderId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const folderId = objectIdSchema.parse(params.folderId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = updateFolderSchema.parse(body);

    const folder = await folderService.updateFolder(actor, folderId, input, meta);
    return ok(toFolderDto(folder));
  },
);

/** Moves a folder and its subtree to the trash. Purged after the retention window. */
export const DELETE = withAuthenticatedRoute<{ folderId: string }>(
  async (_request, { actor, params, meta }) => {
    const folderId = objectIdSchema.parse(params.folderId);
    const result = await folderService.trashFolder(actor, folderId, meta);
    return ok(result);
  },
);
