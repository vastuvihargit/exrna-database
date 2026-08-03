import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toNotificationDto } from '@/server/http/dto';
import * as notificationRepository from '@/server/repositories/notification.repository';
import { notificationsQuerySchema } from '@/server/validation/sharing.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The caller's own notifications.
 *
 * There is no user parameter and no admin variant: every query in the repository is
 * scoped by the actor's own id, so there is no code path that returns someone else's.
 */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const query = notificationsQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );

  const [items, unread] = await Promise.all([
    notificationRepository.listForUser(actor.userId, query),
    notificationRepository.countUnread(actor.userId),
  ]);

  return ok({ items: items.map(toNotificationDto), unread });
});
