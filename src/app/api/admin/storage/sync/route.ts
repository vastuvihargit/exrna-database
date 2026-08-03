import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { driveSyncService } from '@/server/services/drive-sync.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const syncSchema = z.object({
  maxPages: z.number().int().min(1).max(100).optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
});

/**
 * Where synchronization has got to.
 *
 * The cursor itself is included because an administrator debugging a stalled sync needs to
 * know whether it is advancing — but this is behind `access.manage`, and nothing on the
 * employee-facing side of the application reads it (§19).
 */
export const GET = withAuthenticatedRoute(async (_request: NextRequest, { actor }) => {
  assertCompanyPermission(actor, 'access.manage');
  return ok(await driveSyncService.getSyncStatus());
});

/**
 * Runs synchronization now.
 *
 * Normally driven by the scheduler (`npm run drive:sync`); this exists so an administrator
 * can pick up a change immediately — typically after somebody says "I renamed it in Drive
 * and it still shows the old name here".
 *
 * Safe to call at any time and as often as you like. Every change application is idempotent
 * and the cursor advances only after a page has been applied, so the worst outcome of a bad
 * run is that the same page is applied again next time.
 */
export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  assertCompanyPermission(actor, 'access.manage');

  const body: unknown = await request.json().catch(() => ({}));
  const input = syncSchema.parse(body);

  return ok(
    await driveSyncService.syncDriveChanges({
      organizationId: actor.organizationId,
      ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}),
      ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
    }),
  );
});
