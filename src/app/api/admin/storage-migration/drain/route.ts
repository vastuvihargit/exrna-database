import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { storageMigrationService } from '@/server/services/storage-migration.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const drainSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});

/**
 * Moves queued uploads on to the Shared Drive.
 *
 * These are files an employee uploaded recently — complete, readable, and stored on this
 * server — that have not yet been copied to Drive. Large uploads are always queued rather
 * than transferred during the request; anything else here is the backlog from a period when
 * Drive was unreachable.
 *
 * Safe to call at any time and as often as you like. A failure leaves each file exactly as
 * it was, so the worst outcome of a bad run is that nothing moved.
 *
 * Normally driven by the scheduler (`npm run drive:drain`); this endpoint exists so an
 * administrator can clear a backlog immediately after fixing a connection.
 */
export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  assertCompanyPermission(actor, 'access.manage');

  const body: unknown = await request.json().catch(() => ({}));
  const input = drainSchema.parse(body);

  return ok(await storageMigrationService.drainPendingForActor(actor, input));
});
