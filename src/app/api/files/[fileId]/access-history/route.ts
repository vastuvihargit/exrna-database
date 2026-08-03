import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { requireFile } from '@/server/services/file-access';
import * as auditRepository from '@/server/repositories/audit-log.repository';
import { objectIdSchema, paginationSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Who opened or downloaded this file. */
const VISIBLE_ACTIONS = new Set(['file.download', 'file.preview']);

/**
 * View and download history for one file.
 *
 * Read from the audit log rather than a separate counter table: the audit entries are
 * already written on every download and preview, and a second store would be a second
 * thing to keep in step — and a place where the two could disagree about who read what.
 *
 * Gated on `access.manage`. Knowing which colleagues opened a file is surveillance-shaped
 * information; it belongs to whoever administers access to the file, not to everyone who
 * can read it.
 */
export const GET = withAuthenticatedRoute<{ fileId: string }>(
  async (request: NextRequest, { actor, params }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const page = paginationSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );

    const context = await requireFile(actor, fileId, 'access.manage');

    const { items, total } = await auditRepository.query({
      organizationId: actor.organizationId,
      entityType: 'file',
      entityId: fileId,
      page: page.page,
      pageSize: page.pageSize,
    });

    const history = items
      .filter((entry) => VISIBLE_ACTIONS.has(entry.action))
      .map((entry) => ({
        id: entry.id,
        action: entry.action,
        actorUserId: entry.actorUserId,
        actorEmail: entry.actorEmail,
        // The IP is included because the brief requires it for sensitive actions, and
        // "who downloaded the confidential dossier, from where" is the case it is for.
        ip: entry.ip,
        at: entry.createdAt,
      }));

    return ok(
      { fileName: context.file.displayName, downloadCount: context.file.downloadCount, history },
      { meta: { page: page.page, pageSize: page.pageSize, total } },
    );
  },
);
