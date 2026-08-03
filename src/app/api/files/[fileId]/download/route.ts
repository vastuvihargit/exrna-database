import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { streamFile } from '@/server/http/file-response';
import { downloadService } from '@/server/services/download.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** A multi-gigabyte download over a slow link must not be cut off mid-stream. */
export const maxDuration = 300;

/**
 * Secure download.
 *
 * The URL names a file and optionally a version — never a storage location. Permission is
 * checked against the file's own ACL layered on its whole folder chain before the storage
 * layer is touched at all, so a guessed or manipulated id reaches nothing.
 */
export const GET = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const rawVersion = new URL(request.url).searchParams.get('versionId');
    const versionId = rawVersion ? objectIdSchema.parse(rawVersion) : undefined;

    const stream = await downloadService.download(
      actor,
      fileId,
      {
        ...(versionId ? { versionId } : {}),
        rangeHeader: request.headers.get('range'),
      },
      meta,
    );

    return streamFile(stream, request.method);
  },
);

/**
 * HEAD is answered the same way minus the body, so a client can size a download or check
 * range support before committing to it.
 */
export const HEAD = GET;
