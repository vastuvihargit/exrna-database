import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toFolderDto } from '@/server/http/dto';
import { folderService } from '@/server/services/folder.service';
import { parseQuery } from '@/server/validation/common';
import { trashQuerySchema } from '@/server/validation/folder.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Archived folders remain fully readable — archiving takes them out of the way, not away. */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const query = parseQuery(trashQuerySchema, request.url);
  const result = await folderService.listArchive(actor, {
    page: query.page,
    pageSize: query.pageSize,
  });

  return ok(
    { folders: result.items.map(toFolderDto), files: [] },
    {
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: result.total,
        hasMore: query.page * query.pageSize < result.total,
      },
    },
  );
});
