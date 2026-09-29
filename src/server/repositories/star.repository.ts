/**
 * Star repository — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_SEARCH`, together with recent items and saved searches. The three are
 * one module because they are the *lifecycle read paths* — Starred, Recent and the saved-search
 * sidebar — and because splitting them buys nothing: none of them can be moved usefully on its
 * own, and three flags would be three ways to end up half-migrated.
 *
 * Note what is deliberately *not* behind this flag: which files a Starred page actually shows.
 * That comes from `DATA_SOURCE_FILES` and `DATA_SOURCE_FOLDERS`, because this repository only
 * ever returns ids and the file and folder repositories decide what the actor may see. A star
 * stored in D1 pointing at a file still on Mongo resolves correctly, which is what makes the
 * flag safe to move on its own.
 */
import { isD1 } from './data-source';
import { mongoStarRepository } from './star.repository.mongo';
import { d1StarRepository } from './star.repository.d1';
import type {
  AddStarInput,
  RemoveStarInput,
  StarRef,
  StarRepository,
  StarrableType,
} from './star.repository.contract';

export type { AddStarInput, RemoveStarInput, StarRef, StarRepository, StarrableType };

export { mongoStarRepository, d1StarRepository };

function active(): StarRepository {
  return isD1('search') ? d1StarRepository : mongoStarRepository;
}

export function add(input: AddStarInput): Promise<void> {
  return active().add(input);
}

export function remove(input: RemoveStarInput): Promise<void> {
  return active().remove(input);
}

export function starredIdsAmong(
  userId: string,
  entityType: StarrableType,
  entityIds: string[],
): Promise<Set<string>> {
  return active().starredIdsAmong(userId, entityType, entityIds);
}

export function listForUser(
  userId: string,
  options: { entityType?: StarrableType; limit?: number } = {},
): Promise<StarRef[]> {
  return active().listForUser(userId, options);
}

export function removeAllFor(entityType: StarrableType, entityIds: string[]): Promise<void> {
  return active().removeAllFor(entityType, entityIds);
}
