import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toActivityDto } from '@/server/http/dto';
import { requireFolder } from '@/server/services/folder-access';
import * as activityRepository from '@/server/repositories/activity.repository';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Activity timeline for a folder and everything inside it.
 *
 * Gated on being able to view the folder itself: the timeline names files and people,
 * so it must not be readable by anyone who cannot open the folder.
 */
export const GET = withAuthenticatedRoute<{ folderId: string }>(
  async (_request, { actor, params }) => {
    const folderId = objectIdSchema.parse(params.folderId);
    await requireFolder(actor, folderId, 'file.view');

    const entries = await activityRepository.listForFolderTree(folderId, 50);
    return ok(entries.map(toActivityDto));
  },
);
