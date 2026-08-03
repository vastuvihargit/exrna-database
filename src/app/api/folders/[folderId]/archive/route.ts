import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toFolderDto } from '@/server/http/dto';
import { folderService } from '@/server/services/folder.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ archived: z.boolean() });

export const POST = withAuthenticatedRoute<{ folderId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const folderId = objectIdSchema.parse(params.folderId);
    const body: unknown = await request.json().catch(() => ({}));
    const { archived } = bodySchema.parse(body);

    const folder = await folderService.setArchived(actor, folderId, archived, meta);
    return ok(toFolderDto(folder));
  },
);
