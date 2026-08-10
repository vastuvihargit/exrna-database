/**
 * Recent-items repository — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_SEARCH`, with stars and saved searches. See `star.repository.ts` for
 * why the three move together and why this flag is independent of `DATA_SOURCE_FILES`.
 */
import { isD1 } from './data-source';
import { mongoRecentItemRepository } from './recent-item.repository.mongo';
import { d1RecentItemRepository } from './recent-item.repository.d1';
import type {
  RecentEntityType,
  RecentItemRepository,
  RecentRef,
  TouchRecentInput,
} from './recent-item.repository.contract';

export type { RecentEntityType, RecentItemRepository, RecentRef, TouchRecentInput };

export { mongoRecentItemRepository, d1RecentItemRepository };

function active(): RecentItemRepository {
  return isD1('search') ? d1RecentItemRepository : mongoRecentItemRepository;
}

export function touch(input: TouchRecentInput): Promise<void> {
  return active().touch(input);
}

export function listForUser(
  userId: string,
  options: { entityType?: RecentEntityType; limit?: number } = {},
): Promise<RecentRef[]> {
  return active().listForUser(userId, options);
}

export function removeAllFor(
  entityType: RecentEntityType,
  entityIds: string[],
): Promise<void> {
  return active().removeAllFor(entityType, entityIds);
}
