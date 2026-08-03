import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { streamFile } from '@/server/http/file-response';
import { downloadService } from '@/server/services/download.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Secure inline preview.
 *
 * Only extensions on the previewable allow-list are served inline, and the response
 * carries a sandboxing CSP plus `X-Content-Type-Options: nosniff` — so even a file that
 * lied its way past validation cannot execute script in this origin.
 *
 * Range requests are honoured, which is what makes audio and video seekable.
 */
export const GET = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const rawVersion = new URL(request.url).searchParams.get('versionId');
    const versionId = rawVersion ? objectIdSchema.parse(rawVersion) : undefined;

    const stream = await downloadService.preview(
      actor,
      fileId,
      {
        ...(versionId ? { versionId } : {}),
        rangeHeader: request.headers.get('range'),
      },
      meta,
    );

    return streamFile(stream, request.method, { sandbox: true });
  },
);

export const HEAD = GET;
