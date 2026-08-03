import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { driveService } from '@/server/services/drive.service';
import { folderService } from '@/server/services/folder.service';
import { toBreadcrumbDto, toFolderDto } from '@/server/http/dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Opens the caller's personal drive, creating its root on first use.
 * Returns the same envelope as GET /api/folders/[id] so the client has one code path.
 */
export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  const root = await driveService.getMyDriveRoot(actor);
  const result = await folderService.getFolder(actor, root.id);
  return ok({
    folder: toFolderDto(result.folder),
    breadcrumbs: result.breadcrumbs.map(toBreadcrumbDto),
  });
});
