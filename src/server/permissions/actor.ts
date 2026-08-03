/**
 * The Actor — everything the permission layer needs to decide a request, assembled
 * once per request and never cached across requests.
 *
 * Not caching across requests is deliberate: the brief requires permission and
 * deactivation changes to take effect immediately. A five-minute permission cache
 * would mean a five-minute window in which a revoked employee still has access.
 */
import type { ConfidentialityLevel, Permission, ScopeType } from '@/server/domain/permissions';

export interface RoleGrant {
  roleId: string;
  roleKey: string;
  roleName: string;
  rank: number;
  scopeType: ScopeType;
  /** null for company scope. */
  scopeId: string | null;
  permissions: Permission[];
  maxConfidentiality: ConfidentialityLevel;
  companyWideRead: boolean;
}

export interface Actor {
  userId: string;
  email: string;
  name: string;
  organizationId: string;
  departmentId: string | null;
  projectIds: string[];
  isSuperAdmin: boolean;
  status: string;
  grants: RoleGrant[];
  /** Union of every permission from every grant, for cheap "can they ever do X" checks. */
  permissions: Set<Permission>;
  roleKeys: string[];
  /** Highest rank held — used to prevent granting a role above your own. */
  highestRank: number;
  sessionId: string;
  storageQuotaBytes: number;
  storageUsedBytes: number;
}

/** A resource the permission layer can be asked about. Folder/file fields land in Phase 3–4. */
export interface ResourceRef {
  type: 'organization' | 'department' | 'project' | 'folder' | 'file' | 'user' | 'role';
  id: string;
  organizationId?: string;
  departmentId?: string | null;
  projectId?: string | null;
  ownerId?: string | null;
  confidentiality?: ConfidentialityLevel;
  /** Ordered root→parent folder ids, for inherited ACL resolution (Phase 3). */
  folderAncestorIds?: string[];
  /** Direct ACL entries on the resource (Phase 3). */
  acl?: AclEntry[];
  inheritPermissions?: boolean;
  status?: string;
  deletedAt?: Date | null;
}

export interface AclEntry {
  principalType: 'user' | 'department' | 'project' | 'role';
  principalId: string;
  accessLevel: string;
  /** An explicit deny beats every allow. */
  deny?: boolean;
  expiresAt?: Date | null;
}

export function actorHasPermissionAnywhere(actor: Actor, permission: Permission): boolean {
  return actor.isSuperAdmin || actor.permissions.has(permission);
}

/** Highest confidentiality reachable through role scope alone (never `restricted`). */
export function actorClearance(actor: Actor): ConfidentialityLevel {
  if (actor.isSuperAdmin) return 'restricted';
  let best: ConfidentialityLevel = 'public_internal';
  const order: ConfidentialityLevel[] = ['public_internal', 'internal', 'confidential', 'restricted'];
  for (const grant of actor.grants) {
    if (order.indexOf(grant.maxConfidentiality) > order.indexOf(best)) {
      best = grant.maxConfidentiality;
    }
  }
  return best;
}

export function actorHasCompanyWideRead(actor: Actor): boolean {
  return actor.isSuperAdmin || actor.grants.some((grant) => grant.companyWideRead);
}
