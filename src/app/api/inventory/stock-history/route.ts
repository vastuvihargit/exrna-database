import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toStockTransactionDto } from '@/server/http/dto';
import { stockService } from '@/server/services/stock.service';
import { parseQuery } from '@/server/validation/common';
import { listStockHistorySchema } from '@/server/validation/inventory.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The stock ledger across the whole organization.
 *
 * The per-item view lives under `/api/inventory/items/[itemId]/stock`; this one answers the
 * questions that cross items — what did this project consume, what did this person issue, what
 * moved last week. Both are the same rows and the same filters.
 *
 * There is no POST, PATCH or DELETE here and there never will be. Stock moves through the item
 * route, which writes the ledger row inside the same transaction as the movement; a route that
 * could append a row on its own would let history be written without anything having happened.
 */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const query = parseQuery(listStockHistorySchema, request.url);
  const { transactions, total } = await stockService.history(actor, query);

  return ok(transactions.map(toStockTransactionDto), {
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasMore: total > query.page * query.pageSize,
    },
  });
});
