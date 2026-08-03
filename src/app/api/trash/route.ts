import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toFileDto, toFolderDto } from '@/server/http/dto';
import { fileService } from '@/server/services/file.service';
import { folderService } from '@/server/services/folder.service';
import { parseQuery } from '@/server/validation/common';
import { trashQuerySchema } from '@/server/validation/folder.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Only what the user deleted directly — descendants come back with their parent. */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const query = parseQuery(trashQuerySchema, request.url);

  const [folders, files] = await Promise.all([
    folderService.listTrash(actor, { page: query.page, pageSize: query.pageSize }),
    fileService.listTrash(actor, { page: query.page, pageSize: query.pageSize }),
  ]);

  return ok(
    { folders: folders.items.map(toFolderDto), files: files.items.map(toFileDto) },
    {
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: folders.total + files.total,
        hasMore: false,
      },
    },
  );
});
