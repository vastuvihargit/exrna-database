import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { noContent, ok } from '@/server/http/api-response';
import { toInventoryItemDto } from '@/server/http/dto';
import { inventoryService } from '@/server/services/inventory.service';
import { objectIdSchema } from '@/server/validation/common';
import { updateInventoryItemSchema } from '@/server/validation/inventory.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute<{ itemId: string }>(async (_request, { actor, params }) => {
  const itemId = objectIdSchema.parse(params.itemId);
  return ok(toInventoryItemDto(await inventoryService.getById(actor, itemId)));
});

/**
 * Edits the definition only.
 *
 * The update schema is `strict()` and contains no quantity field, so an attempt to set
 * `availableQuantity` here is a 422 rather than a silently dropped property. Stock moves
 * through /api/inventory/stock/*, which writes history.
 */
export const PATCH = withAuthenticatedRoute<{ itemId: string }>(
  async (request: NextRequest, { actor, params, meta }) => {
    const itemId = objectIdSchema.parse(params.itemId);
    const body: unknown = await request.json().catch(() => ({}));
    const input = updateInventoryItemSchema.parse(body);

    return ok(toInventoryItemDto(await inventoryService.update(actor, itemId, input, meta)));
  },
);

/**
 * Retires the item. Refused while stock remains — material on a shelf with no record of it
 * is the outcome this module exists to prevent. Its transaction history is untouched.
 */
export const DELETE = withAuthenticatedRoute<{ itemId: string }>(
  async (_request, { actor, params, meta }) => {
    const itemId = objectIdSchema.parse(params.itemId);
    await inventoryService.deactivate(actor, itemId, meta);
    return noContent();
  },
);
