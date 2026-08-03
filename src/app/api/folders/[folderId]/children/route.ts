import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toFileDto, toFolderDto } from '@/server/http/dto';
import { fileService } from '@/server/services/file.service';
import { folderService } from '@/server/services/folder.service';
import { objectIdSchema, parseQuery } from '@/server/validation/common';
import { listChildrenQuerySchema } from '@/server/validation/folder.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Contents of a folder.
 *
 * Folders and files are paginated independently and returned together, because that is
 * how the browser renders them: folders first, then files, the way every drive does it.
 * `total` counts both.
 */
export const GET = withAuthenticatedRoute<{ folderId: string }>(
  async (request: NextRequest, { actor, params }) => {
    const folderId = objectIdSchema.parse(params.folderId);
    const query = parseQuery(listChildrenQuerySchema, request.url);
    const search = query.search ? { search: query.search } : {};

    const [folders, files] = await Promise.all([
      folderService.listChildFolders(actor, folderId, {
        page: query.page,
        pageSize: query.pageSize,
        sort: query.sort,
        order: query.order,
        ...search,
      }),
      fileService.listInFolder(actor, folderId, {
        page: query.page,
        pageSize: query.pageSize,
        sort: query.sort === 'name' ? 'displayName' : query.sort,
        order: query.order,
        ...search,
      }),
    ]);

    const total = folders.total + files.total;

    return ok(
      { folders: folders.items.map(toFolderDto), files: files.items.map(toFileDto) },
      {
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          hasMore:
            folders.total > query.page * query.pageSize || files.total > query.page * query.pageSize,
        },
      },
    );
  },
);
