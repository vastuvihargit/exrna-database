import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { downloadService } from '@/server/services/download.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Opens a Google-native document in Google's own editor.
 *
 * A redirect rather than a JSON payload containing the URL, deliberately. The link is a
 * storage location, and this codebase's standing rule is that locations do not travel in
 * response bodies — a page that fetched one would put it in browser memory, in the network
 * tab, and in any log that records response bodies, for every user who merely *listed* a
 * folder. Here it exists for exactly one navigation, after the permission check.
 *
 * `no-store` for the same reason: a 302 to a document URL is not something an intermediary
 * should be free to keep.
 */
export const GET = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const rawVersion = new URL(request.url).searchParams.get('versionId');
    const versionId = rawVersion ? objectIdSchema.parse(rawVersion) : undefined;

    const opened = await downloadService.openInGoogleEditor(
      actor,
      fileId,
      versionId ? { versionId } : {},
      meta,
    );

    return NextResponse.redirect(opened.url, {
      status: 302,
      headers: { 'Cache-Control': 'no-store' },
    });
  },
);
