/**
 * User repository — the only place user records are queried.
 *
 * This module is now a façade over two implementations. Every caller keeps the import path,
 * the function names and the return types it already had; what changed is that each call is
 * routed to MongoDB or D1 according to `DATA_SOURCE_USERS`.
 *
 * ── Why a façade rather than swapping the file ──────────────────────────────────────────
 *
 * The brief requires a rollback path that stays open until D1 is verified. A swap makes
 * rollback a code change — a build, a deploy, and a window in which the fix is not yet live.
 * A flag makes it an environment variable, and the two implementations sit side by side where
 * they can be run against each other (Phase 6) rather than one replacing the other.
 *
 * The dispatch is per call, not cached at module load, so flipping the variable does not need
 * a restart to take effect on the next request.
 *
 * Callers receive plain objects, never Mongoose documents or Drizzle rows, so no business code
 * can accidentally `.save()` a partially loaded user or serialize a hidden field.
 */
import { isD1 } from './data-source';
import { mongoUserRepository } from './user.repository.mongo';
import { d1UserRepository } from './user.repository.d1';
import type {
  CreateUserInput,
  FindForMentionsInput,
  ListUsersCriteria,
  UserPatch,
  UserRecord,
  UserRepository,
} from './user.repository.contract';

export type {
  CreateUserInput,
  FindForMentionsInput,
  ListUsersCriteria,
  UserPatch,
  UserRecord,
  UserRepository,
};

/** Re-exported so a test can assert the Mongo and D1 paths agree without importing both. */
export { mongoUserRepository, d1UserRepository };

function active(): UserRepository {
  return isD1('users') ? d1UserRepository : mongoUserRepository;
}

export function findById(id: string): Promise<UserRecord | null> {
  return active().findById(id);
}

export function findByIds(ids: string[]): Promise<UserRecord[]> {
  return active().findByIds(ids);
}

export function findByEmail(email: string): Promise<UserRecord | null> {
  return active().findByEmail(email);
}

export function findByEmailWithSecrets(
  email: string,
): Promise<{ user: UserRecord; passwordHash: string | null } | null> {
  return active().findByEmailWithSecrets(email);
}

export function findForMentions(input: FindForMentionsInput): Promise<UserRecord[]> {
  return active().findForMentions(input);
}

export function list(
  criteria: ListUsersCriteria,
): Promise<{ items: UserRecord[]; total: number }> {
  return active().list(criteria);
}

export function create(input: CreateUserInput): Promise<UserRecord> {
  return active().create(input);
}

export function updateById(id: string, patch: UserPatch): Promise<UserRecord | null> {
  return active().updateById(id, patch);
}

export function setPasswordHash(id: string, passwordHash: string): Promise<void> {
  return active().setPasswordHash(id, passwordHash);
}

export function recordFailedLogin(id: string, lockThreshold: number): Promise<number> {
  return active().recordFailedLogin(id, lockThreshold);
}

export function recordSuccessfulLogin(id: string): Promise<void> {
  return active().recordSuccessfulLogin(id);
}

export function linkAuthProvider(
  id: string,
  provider: 'password' | 'google' | 'microsoft',
  providerAccountId: string | null,
): Promise<void> {
  return active().linkAuthProvider(id, provider, providerAccountId);
}

export function countByOrganization(organizationId: string): Promise<number> {
  return active().countByOrganization(organizationId);
}
