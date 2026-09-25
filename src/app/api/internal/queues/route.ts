import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { withRouteHandler } from '@/server/http/route-handler';
import { ok } from '@/server/http/api-response';
import { NotFoundError } from '@/server/errors/app-error';
import { safeCompare } from '@/server/auth/tokens';
import { INTERNAL_QUEUE_HEADER, internalQueueToken } from '@/server/queues/internal-token';
import { processQueueMessage } from '@/server/queues/consumers';
import { QUEUE_KINDS } from '@/server/queues/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deliverySchema = z
  .object({
    queue: z.enum(QUEUE_KINDS),
    messageId: z.string().min(1).max(200),
    attempts: z.number().int().min(1),
    body: z.unknown(),
  })
  .strict();

/**
 * Queue delivery, from the Worker entrypoint to the consumers — see `queues/internal-token.ts`.
 *
 * 404 rather than 401 for anything without the in-process token, so the endpoint is
 * indistinguishable from one that does not exist.
 */
export const POST = withRouteHandler(async (request: NextRequest) => {
  const expected = internalQueueToken();
  const presented = request.headers.get(INTERNAL_QUEUE_HEADER);
  if (!expected || !presented || !safeCompare(expected, presented)) {
    throw new NotFoundError('Not found');
  }

  const delivery = deliverySchema.parse(await request.json());
  return ok(await processQueueMessage({ ...delivery, body: delivery.body }));
});
