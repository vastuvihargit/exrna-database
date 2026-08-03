import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toFolderDto } from '@/server/http/dto';
import { folderService } from '@/server/services/folder.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuthenticatedRoute<{ folderId: string }>(
  async (_request, { actor, params, meta }) => {
    const folderId = objectIdSchema.parse(params.folderId);
    const folder = await folderService.restoreFolder(actor, folderId, meta);
    return ok(toFolderDto(folder));
  },
);
