import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toFileDto, toFolderDto } from '@/server/http/dto';
import { fileService } from '@/server/services/file.service';
import { folderService } from '@/server/services/folder.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Starred items are re-authorized on every read: access can be revoked after something
 * was starred, and a star must never keep a door open.
 */
export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  const [folders, files] = await Promise.all([
    folderService.listStarred(actor),
    fileService.listStarred(actor),
  ]);
  return ok({ folders: folders.map(toFolderDto), files: files.map(toFileDto) });
});
