/**
 * Authorization decisions.
 *
 * Implements the resolution algorithm from docs/phase-0/05-auth-and-permissions.md.
 * Phase 2 exercises steps 1–4 and 7–10 (status, deny, super admin, ownership, role
 * scope, confidentiality gate); the folder-inheritance branch (steps 5–6) is wired here
 * and becomes reachable in Phase 3 when folders exist.
 *
 * Every backend route calls assertCan(). The frontend's copy of the actor is for
 * rendering only and is never trusted.
 */
import { ForbiddenError, NotFoundError } from '@/server/errors/app-error';
import {
  CONFIDENTIALITY_RANK,
  OWNER_PERMISSIONS,
  permissionsForAccessLevel,
  type AccessLevel,
  type ConfidentialityLevel,
  type Permission,
} from '@/server/domain/permissions';
import {
  actorClearance,
  type Actor,
  type AclEntry,
  type ResourceRef,
} from './actor';

export type AuthorizationDecision =
  | { allowed: true; reason: 'super_admin' | 'acl' | 'inherited_acl' | 'owner' | 'role_scope' }
  | {
      allowed: false;
      reason:
        | 'inactive_actor'
        | 'explicit_deny'
        | 'no_grant'
        | 'confidentiality'
        | 'deleted_resource'
        | 'wrong_organization';
    };

function aclGrants(entries: AclEntry[] | undefined, actor: Actor, permission: Permission) {
  if (!entries?.length) return { allow: false, deny: false };

  const now = Date.now();
  let allow = false;
  let deny = false;

  for (const entry of entries) {
    if (entry.expiresAt && entry.expiresAt.getTime() <= now) continue;

    const matches =
      (entry.principalType === 'user' && entry.principalId === actor.userId) ||
      (entry.principalType === 'department' && entry.principalId === actor.departmentId) ||
      (entry.principalType === 'project' && actor.projectIds.includes(entry.principalId)) ||
      (entry.principalType === 'role' && actor.grants.some((g) => g.roleId === entry.principalId));

    if (!matches) continue;

    if (entry.deny) {
      deny = true;
      continue;
    }
    if (permissionsForAccessLevel(entry.accessLevel as AccessLevel)?.includes(permission)) {
      allow = true;
    }
  }

  return { allow, deny };
}

function roleScopeGrants(actor: Actor, permission: Permission, resource: ResourceRef): boolean {
  for (const grant of actor.grants) {
    if (!grant.permissions.includes(permission)) continue;

    switch (grant.scopeType) {
      case 'company':
        return true;
      case 'department':
        if (grant.scopeId && grant.scopeId === resource.departmentId) return true;
        // A department-scoped grant also covers the department record itself.
        if (resource.type === 'department' && grant.scopeId === resource.id) return true;
        break;
      case 'project':
        if (grant.scopeId && grant.scopeId === resource.projectId) return true;
        if (resource.type === 'project' && grant.scopeId === resource.id) return true;
        break;
      case 'folder':
        if (grant.scopeId && resource.folderAncestorIds?.includes(grant.scopeId)) return true;
        if (resource.type === 'folder' && grant.scopeId === resource.id) return true;
        break;
      case 'file':
        if (resource.type === 'file' && grant.scopeId === resource.id) return true;
        break;
    }
  }
  return false;
}

/**
 * Ancestor ACLs are resolved by the caller (Phase 3 loads them in one query) and passed
 * as `ancestorAcls`, ordered root → parent. Inheritance stops at the first ancestor
 * that has broken it.
 */
export interface AuthorizeOptions {
  ancestorAcls?: Array<{ folderId: string; acl: AclEntry[]; inheritPermissions: boolean }>;
}

export function canAccess(
  actor: Actor,
  permission: Permission,
  resource: ResourceRef,
  options: AuthorizeOptions = {},
): AuthorizationDecision {
  // 1. The actor must be usable at all.
  if (actor.status !== 'active') return { allowed: false, reason: 'inactive_actor' };

  // 2. Cross-tenant access is never permitted, super admin included.
  if (resource.organizationId && resource.organizationId !== actor.organizationId) {
    return { allowed: false, reason: 'wrong_organization' };
  }

  // 3. Deleted or trashed resources only answer to restore/view-in-trash.
  const restoreActions: Permission[] = ['resource.restore', 'file.view'];
  if ((resource.deletedAt || resource.status === 'trashed') && !restoreActions.includes(permission)) {
    return { allowed: false, reason: 'deleted_resource' };
  }

  // 4. An explicit deny anywhere in the chain wins over every allow.
  const direct = aclGrants(resource.acl, actor, permission);
  if (direct.deny) return { allowed: false, reason: 'explicit_deny' };

  const inheritable = resource.inheritPermissions !== false ? (options.ancestorAcls ?? []) : [];
  // Walk leaf → root so the nearest ancestor that breaks inheritance stops the walk.
  let inheritedAllow = false;
  for (let i = inheritable.length - 1; i >= 0; i -= 1) {
    const ancestor = inheritable[i]!;
    const result = aclGrants(ancestor.acl, actor, permission);
    if (result.deny) return { allowed: false, reason: 'explicit_deny' };
    if (result.allow) inheritedAllow = true;
    if (!ancestor.inheritPermissions) break;
  }

  // 5. Super admin — allowed, but still audited by the caller.
  if (actor.isSuperAdmin) return { allowed: true, reason: 'super_admin' };

  // 6/7. Explicit grants on the resource or inherited from a folder.
  if (direct.allow) return { allowed: true, reason: 'acl' };
  if (inheritedAllow) return { allowed: true, reason: 'inherited_acl' };

  // 8. Ownership covers the everyday actions on your own content.
  //    The confidentiality gate does not apply here: it exists to stop *other* people
  //    reading above their clearance, and the owner is the person who classified the
  //    file in the first place.
  if (resource.ownerId && resource.ownerId === actor.userId) {
    if (OWNER_PERMISSIONS.includes(permission)) return { allowed: true, reason: 'owner' };

    // `access.manage` is deliberately not an ordinary owner permission: in a department
    // or project drive the "owner" is merely whoever uploaded the file, and letting them
    // break inheritance would let a junior researcher hide work from the department head
    // who is accountable for it.
    //
    // In a *personal* drive there is nobody else to administer it. Personal content
    // carries neither a department nor a project by construction (see the Phase 3 drive
    // design), so no role scope reaches it and ownership is the only route in. Without
    // this branch, denies and inheritance changes would be unreachable there — not
    // restricted, simply impossible for anyone at all.
    if (permission === 'access.manage' && !resource.departmentId && !resource.projectId) {
      return { allowed: true, reason: 'owner' };
    }
  }

  // 9. Role grants at a scope that contains the resource.
  if (roleScopeGrants(actor, permission, resource)) {
    if (!passesConfidentialityGate(actor, resource)) {
      return { allowed: false, reason: 'confidentiality' };
    }
    return { allowed: true, reason: 'role_scope' };
  }

  return { allowed: false, reason: 'no_grant' };
}

/**
 * Applied only to allows that came from role scope.
 *
 * `restricted` is never reachable this way — it requires an explicit ACL entry on the
 * resource or its folder. Below that, the actor's clearance must cover the resource's
 * classification.
 */
function passesConfidentialityGate(actor: Actor, resource: ResourceRef): boolean {
  const level: ConfidentialityLevel | undefined = resource.confidentiality;
  if (!level) return true;
  if (level === 'restricted') return false;
  return CONFIDENTIALITY_RANK[actorClearance(actor)] >= CONFIDENTIALITY_RANK[level];
}

export function can(
  actor: Actor,
  permission: Permission,
  resource: ResourceRef,
  options?: AuthorizeOptions,
): boolean {
  return canAccess(actor, permission, resource, options).allowed;
}

/**
 * Throws when the actor may not perform the action.
 *
 * A resource the actor cannot even see produces 404, not 403: a 403 on an unknown id
 * confirms that the id exists, which is an enumeration oracle
 * (docs/phase-0/08-security-threat-model.md).
 */
export function assertCan(
  actor: Actor,
  permission: Permission,
  resource: ResourceRef,
  options?: AuthorizeOptions,
): void {
  const decision = canAccess(actor, permission, resource, options);
  if (decision.allowed) return;

  // Visibility is the dividing line, not the specific reason for the refusal: an actor
  // who cannot even view the resource must be told 404 whatever action they asked for,
  // because a 403 on an id they cannot see confirms that the id exists. 403 is reserved
  // for "you can see this, but you may not do that" — which is a useful message and
  // reveals nothing the actor did not already know.
  const canView =
    permission !== 'file.view' && canAccess(actor, 'file.view', resource, options).allowed;

  const invisible =
    !canView ||
    decision.reason === 'wrong_organization' ||
    decision.reason === 'confidentiality' ||
    decision.reason === 'deleted_resource';

  if (invisible) throw new NotFoundError();
  throw new ForbiddenError();
}

/** Company-wide administrative checks that are not about a specific resource. */
export function assertCompanyPermission(actor: Actor, permission: Permission): void {
  if (actor.status !== 'active') throw new ForbiddenError();
  if (actor.isSuperAdmin) return;

  const hasCompanyScope = actor.grants.some(
    (grant) => grant.scopeType === 'company' && grant.permissions.includes(permission),
  );
  if (!hasCompanyScope) throw new ForbiddenError();
}

/**
 * Prevents privilege escalation in both directions: you cannot grant a role ranked at
 * or above your own, and you cannot grant a permission you do not hold yourself.
 */
export function assertCanGrantRole(
  actor: Actor,
  role: { rank: number; permissions: Permission[]; key: string },
): void {
  if (actor.isSuperAdmin) return;

  if (role.rank >= actor.highestRank) {
    throw new ForbiddenError('You cannot grant a role at or above your own privilege level');
  }
  const missing = role.permissions.filter((permission) => !actor.permissions.has(permission));
  if (missing.length > 0) {
    throw new ForbiddenError('You cannot grant permissions you do not hold yourself');
  }
}
