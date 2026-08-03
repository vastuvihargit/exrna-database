import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import * as notificationRepository from '@/server/repositories/notification.repository';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  /** Omit to mark everything read. */
  notificationId: objectIdSchema.optional(),
});

export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const { notificationId } = schema.parse(body);

  if (notificationId) {
    await notificationRepository.markRead(actor.userId, notificationId);
  } else {
    await notificationRepository.markAllRead(actor.userId);
  }

  return ok({ unread: await notificationRepository.countUnread(actor.userId) });
});
