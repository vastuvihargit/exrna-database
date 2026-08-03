import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toFileDto, toFolderDto } from '@/server/http/dto';
import { fileService } from '@/server/services/file.service';
import { folderService } from '@/server/services/folder.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  const [folders, files] = await Promise.all([
    folderService.listRecent(actor),
    fileService.listRecent(actor),
  ]);
  return ok({ folders: folders.map(toFolderDto), files: files.map(toFileDto) });
});
