import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created, ok } from '@/server/http/api-response';
import { toInventoryItemDto } from '@/server/http/dto';
import { inventoryService } from '@/server/services/inventory.service';
import { parseQuery } from '@/server/validation/common';
import {
  createInventoryItemSchema,
  listInventoryItemsSchema,
} from '@/server/validation/inventory.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The item catalogue.
 *
 * Organization-wide for anyone holding `inventory.view`: what is on the shelf is
 * operational information, not research content (see `inventoryVisibilityFilter`). The
 * `capabilities` on each row say what *this* reader may do with it, so the UI can offer
 * actions without guessing.
 */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const query = parseQuery(listInventoryItemsSchema, request.url);

  const { items, total } = await inventoryService.list(actor, query);

  return ok(items.map(toInventoryItemDto), {
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasMore: total > query.page * query.pageSize,
    },
  });
});

/**
 * Creates an item definition. It comes into existence empty — stock arrives through a
 * receipt, which records where it came from.
 */
export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor, meta }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = createInventoryItemSchema.parse(body);

  const item = await inventoryService.create(actor, input, meta);
  return created(toInventoryItemDto(item));
});
