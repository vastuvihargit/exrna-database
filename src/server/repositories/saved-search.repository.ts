/**
 * Saved-search repository — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_SEARCH`, with stars and recent items. See `star.repository.ts`.
 */
import { isD1 } from './data-source';
import { mongoSavedSearchRepository } from './saved-search.repository.mongo';
import { d1SavedSearchRepository } from './saved-search.repository.d1';
import type {
  SavedSearchRecord,
  SavedSearchRepository,
  UpsertSavedSearchInput,
} from './saved-search.repository.contract';

export type { SavedSearchRecord, SavedSearchRepository, UpsertSavedSearchInput };

export { mongoSavedSearchRepository, d1SavedSearchRepository };

function active(): SavedSearchRepository {
  return isD1('search') ? d1SavedSearchRepository : mongoSavedSearchRepository;
}

export function listForUser(userId: string): Promise<SavedSearchRecord[]> {
  return active().listForUser(userId);
}

export function findOwned(userId: string, id: string): Promise<SavedSearchRecord | null> {
  return active().findOwned(userId, id);
}

export function upsert(input: UpsertSavedSearchInput): Promise<SavedSearchRecord> {
  return active().upsert(input);
}

export function update(
  userId: string,
  id: string,
  changes: { name?: string; isPinned?: boolean },
): Promise<SavedSearchRecord | null> {
  return active().update(userId, id, changes);
}

export function remove(userId: string, id: string): Promise<boolean> {
  return active().remove(userId, id);
}

export function markRun(userId: string, id: string): Promise<void> {
  return active().markRun(userId, id);
}
