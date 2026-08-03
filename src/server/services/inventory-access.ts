/**
 * Authorization for inventory.
 *
 * ── Why this is not `canAccess` ─────────────────────────────────────────────────────
 *
 * `src/server/permissions/authorize.ts` resolves ACLs, folder inheritance, ownership and a
 * confidentiality gate. An inventory item has none of those: no owner, no per-resource
 * grants, no classification. Routing it through `canAccess` would mean inventing a resource
 * type and adding a branch to `roleScopeGrants` — changes to the most security-critical
 * file in the codebase, to express a rule that is two lines long.
 *
 * `assertCompanyPermission` already exists for exactly this shape of question:
 * "an administrative check that is not about an ACL-bearing resource". This is its
 * department-scoped sibling, and it follows the same order and the same failure mode.
 *
 * ── The rule ────────────────────────────────────────────────────────────────────────
 *
 * Reading is organization-wide (see `inventoryVisibilityFilter`) and only requires holding
 * `inventory.view` somewhere. Changing stock is scoped:
 *
 *   • a company-scoped grant carrying the permission reaches every item
 *   • a department-scoped grant reaches items whose custodian department it names
 *   • a central-store item (departmentId null) is reachable only from company scope,
 *     which is what "central" means
 *
 * Nothing here trusts the client. The permission list in the session DTO is a rendering
 * hint; every mutating route calls one of these assertions.
 */
import { ForbiddenError } from '@/server/errors/app-error';
import type { Permission } from '@/server/domain/permissions';
import { actorHasPermissionAnywhere, type Actor } from '@/server/permissions/actor';

/** The part of an item that the decision depends on. */
export interface InventoryScope {
  departmentId: string | null;
}

export function inventoryCan(
  actor: Actor,
  permission: Permission,
  scope: InventoryScope,
): boolean {
  if (actor.status !== 'active') return false;
  if (actor.isSuperAdmin) return true;

  return actor.grants.some((grant) => {
    if (!grant.permissions.includes(permission)) return false;
    if (grant.scopeType === 'company') return true;
    if (grant.scopeType === 'department') {
      return Boolean(scope.departmentId) && grant.scopeId === scope.departmentId;
    }
    // Project-, folder- and file-scoped grants have no meaning for a shelf of reagents.
    return false;
  });
}

export function assertInventoryPermission(
  actor: Actor,
  permission: Permission,
  scope: InventoryScope,
  message?: string,
): void {
  if (!inventoryCan(actor, permission, scope)) {
    throw new ForbiddenError(message ?? 'You cannot perform this action on this inventory item');
  }
}

/**
 * Whether the actor may read inventory at all.
 *
 * A plain 403 rather than a 404 is right here: the existence of an inventory module is not
 * a secret, and telling somebody "you do not have inventory access" is a useful message
 * that discloses nothing. (The 404-for-invisible rule in `assertCan` exists to stop id
 * enumeration; there is no id in this question.)
 */
export function assertCanReadInventory(actor: Actor): void {
  if (actor.status !== 'active' || !actorHasPermissionAnywhere(actor, 'inventory.view')) {
    throw new ForbiddenError('You do not have access to the inventory');
  }
}

/**
 * Whether the actor could perform an action on *some* item.
 *
 * Used to decide whether to offer a create button, where there is no item to scope the
 * question to yet. A create is still authorized against the chosen department when it
 * arrives — this only avoids offering an action that would certainly be refused.
 */
export function hasInventoryPermissionAnywhere(actor: Actor, permission: Permission): boolean {
  if (actor.status !== 'active') return false;
  if (actor.isSuperAdmin) return true;
  return actor.grants.some(
    (grant) =>
      grant.permissions.includes(permission) &&
      (grant.scopeType === 'company' || grant.scopeType === 'department'),
  );
}

export interface InventoryCapabilities {
  edit: boolean;
  addStock: boolean;
  issueStock: boolean;
  adjustStock: boolean;
}

/** What this actor may do with this item, sent so the UI can hide dead ends. */
export function capabilitiesFor(actor: Actor, scope: InventoryScope): InventoryCapabilities {
  return {
    edit: inventoryCan(actor, 'inventory.item.manage', scope),
    addStock: inventoryCan(actor, 'inventory.stock.add', scope),
    issueStock: inventoryCan(actor, 'inventory.stock.issue', scope),
    adjustStock: inventoryCan(actor, 'inventory.stock.adjust', scope),
  };
}
