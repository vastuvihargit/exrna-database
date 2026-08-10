import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created, ok } from '@/server/http/api-response';
import { toInventoryItemDto, toStockTransactionDto } from '@/server/http/dto';
import { inventoryService } from '@/server/services/inventory.service';
import { stockService } from '@/server/services/stock.service';
import { objectIdSchema, parseQuery } from '@/server/validation/common';
import {
  adjustStockSchema,
  issueStockSchema,
  listStockHistorySchema,
  receiveStockSchema,
  stockMovementSchema,
} from '@/server/validation/inventory.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The stock history for one item.
 *
 * Read-only for anybody holding `inventory.view`, like the item itself: what has moved on and
 * off a shelf is operational information. Changing stock is the scoped action, not seeing it.
 */
export const GET = withAuthenticatedRoute(
  async (request: NextRequest, { actor, params }) => {
    const itemId = objectIdSchema.parse(params.itemId);
    const query = parseQuery(listStockHistorySchema, request.url);

    // The path wins over the query string. Accepting both would let `?itemId=` point the
    // response at a different item than the URL names — the same row set, filed under the
    // wrong heading, and cached by a client under the path.
    const { transactions, total } = await stockService.history(actor, { ...query, itemId });

    return ok(transactions.map(toStockTransactionDto), {
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        hasMore: total > query.page * query.pageSize,
      },
    });
  },
);

/**
 * Moves stock: `add`, `issue` or `adjust`.
 *
 * One route with a discriminated body rather than three, because the three share the item
 * lookup, the authorization shape and the response, and because the *client* thinks of them as
 * one dialog with a mode. The permission each one asserts is different and is checked inside
 * the service, against the item's custodian department.
 *
 * Returns 201: every one of these creates a ledger row, and that row's id is what a caller
 * needs to link a delivery note or reverse a mistake.
 */
export const POST = withAuthenticatedRoute(
  async (request: NextRequest, { actor, meta, params }) => {
    const itemId = objectIdSchema.parse(params.itemId);
    const body: unknown = await request.json().catch(() => ({}));
    const movement = stockMovementSchema.parse(body);

    const result =
      movement.action === 'add'
        ? await stockService.receive(
            actor,
            { ...receiveStockSchema.parse(movement.payload), itemId },
            meta,
          )
        : movement.action === 'issue'
          ? await stockService.issue(
              actor,
              { ...issueStockSchema.parse(movement.payload), itemId },
              meta,
            )
          : await stockService.adjust(
              actor,
              { ...adjustStockSchema.parse(movement.payload), itemId },
              meta,
            );

    // The item is returned alongside the ledger row so the client can render the new quantity
    // without a second request — and, more usefully, cannot render a stale one.
    const view = await inventoryService.getById(actor, result.item.id);

    return created({
      transaction: toStockTransactionDto(result.transaction),
      item: toInventoryItemDto(view),
    });
  },
);
