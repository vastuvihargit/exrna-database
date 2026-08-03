import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created } from '@/server/http/api-response';
import { toFolderDto } from '@/server/http/dto';
import { folderService } from '@/server/services/folder.service';
import { createFolderSchema } from '@/server/validation/folder.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor, meta }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = createFolderSchema.parse(body);

  const folder = await folderService.createFolder(
    actor,
    {
      name: input.name,
      parentFolderId: input.parentFolderId,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.confidentiality !== undefined ? { confidentiality: input.confidentiality } : {}),
    },
    meta,
  );

  return created(toFolderDto(folder));
});
