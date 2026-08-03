import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toBreadcrumbDto, toFolderDto } from '@/server/http/dto';
import { driveService } from '@/server/services/drive.service';
import { folderService } from '@/server/services/folder.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute<{ projectId: string }>(
  async (_request, { actor, params }) => {
    const projectId = objectIdSchema.parse(params.projectId);
    const root = await driveService.getProjectRoot(actor, projectId);
    const result = await folderService.getFolder(actor, root.id);
    return ok({
      folder: toFolderDto(result.folder),
      breadcrumbs: result.breadcrumbs.map(toBreadcrumbDto),
    });
  },
);
