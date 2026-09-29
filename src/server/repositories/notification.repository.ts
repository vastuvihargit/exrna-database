/**
 * Notification repository — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_NOTIFICATIONS`.
 *
 * Independently movable: a notification stores `entityId` as an opaque pointer with no foreign
 * key, and rendering one never reads the entity — `entityLabel` was denormalized at send time
 * precisely so the bell menu does not fan out into the file service. So a notification in D1
 * naming a file still on MongoDB displays correctly. What the flag *does* require is identity,
 * because `user_id` and `organization_id` are real foreign keys; `DATA_SOURCE_DEPENDENCIES` in
 * `data-source.ts` records that and `assertDataSourceMatrix()` refuses the split.
 *
 * Moving the flag does not migrate the unread badge: notifications written before the flip live
 * in the other database and stop appearing. That is a cutover consideration rather than a
 * defect — the migration copies them — and it is why the runbook moves this flag with the rest
 * rather than early as a trial.
 */
import { isD1 } from './data-source';
import { mongoNotificationRepository } from './notification.repository.mongo';
import { d1NotificationRepository } from './notification.repository.d1';
import type {
  CreateNotificationInput,
  NotificationRecord,
  NotificationRepository,
  NotificationType,
} from './notification.repository.contract';

export type {
  CreateNotificationInput,
  NotificationRecord,
  NotificationRepository,
  NotificationType,
};

export { mongoNotificationRepository, d1NotificationRepository };

function active(): NotificationRepository {
  return isD1('notifications') ? d1NotificationRepository : mongoNotificationRepository;
}

export function create(input: CreateNotificationInput): Promise<void> {
  return active().create(input);
}

export function createMany(inputs: CreateNotificationInput[]): Promise<void> {
  return active().createMany(inputs);
}

export function listForUser(
  userId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationRecord[]> {
  return active().listForUser(userId, options);
}

export function countUnread(userId: string): Promise<number> {
  return active().countUnread(userId);
}

export function markRead(userId: string, notificationId: string): Promise<boolean> {
  return active().markRead(userId, notificationId);
}

export function markAllRead(userId: string): Promise<number> {
  return active().markAllRead(userId);
}

export function purgeForEntities(entityIds: string[]): Promise<number> {
  return active().purgeForEntities(entityIds);
}
