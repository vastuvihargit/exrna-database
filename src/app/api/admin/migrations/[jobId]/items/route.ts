import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toMigrationItemDto } from '@/server/http/dto';
import { migrationService } from '@/server/services/migration.service';
import { objectIdSchema } from '@/server/validation/common';
import { listMigrationItemsSchema } from '@/server/validation/migration.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The per-file record: what was scanned, what happened to it, and where it went.
 *
 * This is the migration report. Every scanned file has a row whether it was imported,
 * skipped or failed — "every migration item has an audit history" is only true if the
 * skips are visible too.
 */
export const GET = withAuthenticatedRoute<{ jobId: string }>(
  async (request: NextRequest, { actor, params }) => {
    const jobId = objectIdSchema.parse(params.jobId);
    const query = listMigrationItemsSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );

    const { items, total } = await migrationService.listItems(actor, jobId, query);

    return ok(items.map(toMigrationItemDto), {
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        hasMore: total > query.page * query.pageSize,
      },
    });
  },
);
