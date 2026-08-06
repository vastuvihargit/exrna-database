/**
 * Role and role-grant repository — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_ROLES`. See `user.repository.ts` for why this is a flag rather than
 * a swap.
 *
 * ── This module and `users` should move together ────────────────────────────────────────
 *
 * `user.service.ts:decorate()` calls `listGrantsForUser` for every user it returns, so a
 * directory listing reads both repositories on one request. Running users on D1 and roles on
 * Mongo (or vice versa) works — ids are preserved across both databases, which is the whole
 * point of the Phase 2 identity decision — but only for rows that exist in both. During the
 * window before Phase 5 has loaded data, a split flag means a user found in D1 whose grants
 * are looked up in Mongo by an id Mongo has never seen, and the user appears to have no roles.
 *
 * The flags are separate because reverting one module must not revert another. They are not
 * separate because the two are independent in practice.
 */
import { isD1 } from './data-source';
import { mongoRoleRepository } from './role.repository.mongo';
import { d1RoleRepository } from './role.repository.d1';
import type { ScopeType } from '@/server/domain/permissions';
import type { RoleGrant } from '@/server/permissions/actor';
import type {
  GrantRoleInput,
  GrantSummary,
  RoleRecord,
  RoleRepository,
} from './role.repository.contract';

export type { GrantRoleInput, GrantSummary, RoleRecord, RoleRepository, RoleGrant };
export { assertScopeShape } from './role.repository.contract';

/** Re-exported so a test can assert the Mongo and D1 paths agree without importing both. */
export { mongoRoleRepository, d1RoleRepository };

function active(): RoleRepository {
  return isD1('roles') ? d1RoleRepository : mongoRoleRepository;
}

export function listRoles(organizationId: string): Promise<RoleRecord[]> {
  return active().listRoles(organizationId);
}

export function findRoleById(id: string): Promise<RoleRecord | null> {
  return active().findRoleById(id);
}

export function findRolesByIds(ids: string[]): Promise<RoleRecord[]> {
  return active().findRolesByIds(ids);
}

export function findRoleByKey(organizationId: string, key: string): Promise<RoleRecord | null> {
  return active().findRoleByKey(organizationId, key);
}

export function getActorGrants(userId: string): Promise<RoleGrant[]> {
  return active().getActorGrants(userId);
}

export function grantRole(input: GrantRoleInput): Promise<string> {
  return active().grantRole(input);
}

export function revokeGrant(grantId: string, revokedBy: string): Promise<boolean> {
  return active().revokeGrant(grantId, revokedBy);
}

export function listGrantsForUser(userId: string): Promise<GrantSummary[]> {
  return active().listGrantsForUser(userId);
}

export function findActiveGrant(
  userId: string,
  roleId: string,
  scopeType: ScopeType,
  scopeId: string | null,
): Promise<string | null> {
  return active().findActiveGrant(userId, roleId, scopeType, scopeId);
}
