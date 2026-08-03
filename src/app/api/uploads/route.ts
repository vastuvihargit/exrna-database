import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created } from '@/server/http/api-response';
import { uploadService } from '@/server/services/upload.service';
import { authorizeUploadSchema } from '@/server/validation/file.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Step 1 of the upload flow: ask permission.
 *
 * Everything that can reject an upload — folder permission, file type, size, quota,
 * disk headroom — is decided here, before the client sends a single byte.
 */
export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor, meta }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = authorizeUploadSchema.parse(body);

  const ticket = await uploadService.authorizeUpload(
    actor,
    {
      folderId: input.folderId,
      filename: input.filename,
      size: input.size,
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      ...(input.targetFileId !== undefined ? { targetFileId: input.targetFileId } : {}),
      ...(input.versionNote !== undefined ? { versionNote: input.versionNote } : {}),
      ...(input.chunked !== undefined ? { chunked: input.chunked } : {}),
    },
    meta,
  );

  return created(ticket);
});
