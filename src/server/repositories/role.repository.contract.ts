/**
 * The role and role-grant repository contract, stated without reference to either database.
 *
 * `RoleRecord`, `RoleGrant` and `GrantSummary` are **unchanged** from the Mongoose versions.
 * `RoleGrant` in particular is the shape `Actor` is built from, so it is the type that decides
 * what every permission check in the application sees — it is reproduced exactly, not adapted.
 *
 * ── Two listings that look alike and are not ────────────────────────────────────────────
 *
 * `getActorGrants` excludes expired grants. `listGrantsForUser` does not — it is the
 * administrative view, and a grant that has expired is still a fact about the account that an
 * administrator needs to see. Preserving that difference matters more than making the two
 * consistent: collapsing them would either hide history from the admin screen or hand a
 * permission to somebody whose grant ran out.
 *
 * ── `permissions` and `scopeTypes` are sets ─────────────────────────────────────────────
 *
 * MongoDB stored them as arrays and returned them in insertion order; D1 reconstructs them
 * from `role_permissions` / `role_scope_types`. Order is not part of the contract — every
 * consumer uses `.includes()` — and the D1 implementation returns them sorted so that its own
 * output is at least deterministic.
 */
import type { ConfidentialityLevel, Permission, ScopeType } from '@/server/domain/permissions';
import type { RoleGrant } from '@/server/permissions/actor';

export interface RoleRecord {
  id: string;
  organizationId: string;
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
  scopeTypes: ScopeType[];
  rank: number;
  maxConfidentiality: ConfidentialityLevel;
  companyWideRead: boolean;
  isSystem: boolean;
}

export interface GrantRoleInput {
  organizationId: string;
  userId: string;
  roleId: string;
  scopeType: ScopeType;
  scopeId: string | null;
  grantedBy: string;
  expiresAt?: Date | null;
}

export interface GrantSummary {
  id: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  rank: number;
  scopeType: ScopeType;
  scopeId: string | null;
  grantedAt: Date;
  expiresAt: Date | null;
}

/**
 * "A company-scope grant carries no scopeId; every other scope requires one."
 *
 * Enforced by a `pre('validate')` hook on `user-role.model.ts`, which means MongoDB rejects a
 * malformed grant regardless of which code path wrote it. There is **no equivalent constraint
 * on the D1 table** — see `03-…` §4 — so the rule is implemented here, shared by both
 * repositories, rather than reimplemented in each.
 *
 * `user.service.ts` also validates this before calling. That is not redundancy to remove: the
 * service check produces a user-facing `ValidationError`, and this one is the backstop for
 * every other writer (fixtures, seeds, the Phase 5 migration).
 */
export function assertScopeShape(scopeType: ScopeType, scopeId: string | null): void {
  if (scopeType === 'company' && scopeId) {
    throw new Error('A company-scope role grant must not specify a scopeId');
  }
  if (scopeType !== 'company' && !scopeId) {
    throw new Error(`A ${scopeType}-scope role grant requires a scopeId`);
  }
}

export interface RoleRepository {
  listRoles(organizationId: string): Promise<RoleRecord[]>;
  findRoleById(id: string): Promise<RoleRecord | null>;
  findRolesByIds(ids: string[]): Promise<RoleRecord[]>;
  findRoleByKey(organizationId: string, key: string): Promise<RoleRecord | null>;
  getActorGrants(userId: string): Promise<RoleGrant[]>;
  grantRole(input: GrantRoleInput): Promise<string>;
  revokeGrant(grantId: string, revokedBy: string): Promise<boolean>;
  listGrantsForUser(userId: string): Promise<GrantSummary[]>;
  findActiveGrant(
    userId: string,
    roleId: string,
    scopeType: ScopeType,
    scopeId: string | null,
  ): Promise<string | null>;
}

export type { RoleGrant };
