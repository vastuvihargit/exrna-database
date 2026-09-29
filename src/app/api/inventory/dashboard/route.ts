import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { inventoryService } from '@/server/services/inventory.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The four counts behind the inventory dashboard tiles.
 *
 * One request rather than four filtered listings with `pageSize=1` read for their totals: the
 * tiles are shown together, and counting them separately lets a receipt land between two of
 * them so the numbers on screen do not add up.
 */
export const GET = withAuthenticatedRoute(async (_request: NextRequest, { actor }) => {
  return ok(await inventoryService.dashboard(actor));
});
