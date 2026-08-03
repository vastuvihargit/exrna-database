import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toFileDto, toFolderDto } from '@/server/http/dto';
import { sharingService } from '@/server/services/sharing.service';
import { fileCapabilities } from '@/server/services/file-access';
import { folderCapabilities } from '@/server/services/folder-access';
import { isPreviewable } from '@/server/domain/file-types';
import { sharedWithMeQuerySchema } from '@/server/validation/sharing.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Shared with me.
 *
 * Answers "what did someone hand to me personally?", not "what can I see" — a department
 * head can see their whole department, and listing that here would bury the one file a
 * colleague actually shared.
 */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const query = sharedWithMeQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );

  const result = await sharingService.listSharedWithMe(actor, query);

  return ok(
    {
      files: result.files.map((file) =>
        toFileDto({
          ...file,
          isStarred: false,
          previewable: isPreviewable(file.extension),
          capabilities: fileCapabilities(actor, { file, folderChain: [], ancestorAcls: [] }),
        }),
      ),
      folders: result.folders.map((folder) =>
        toFolderDto({
          ...folder,
          isStarred: false,
          capabilities: folderCapabilities(actor, { folder, ancestors: [], ancestorAcls: [] }),
        }),
      ),
    },
    {
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: result.totals.files + result.totals.folders,
      },
    },
  );
});
