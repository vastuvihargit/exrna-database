import { describe, expect, it } from 'vitest';
import {
  assertCan,
  assertCanGrantRole,
  assertCompanyPermission,
  can,
  canAccess,
} from '@/server/permissions/authorize';
import type { Actor, ResourceRef, RoleGrant } from '@/server/permissions/actor';
import type { Permission } from '@/server/domain/permissions';
import { DEFAULT_ROLES, findRoleDefinition } from '@/server/domain/roles';
import { ForbiddenError, NotFoundError } from '@/server/errors/app-error';

const ORG = 'org1';
const DEPT_A = 'deptA';
const DEPT_B = 'deptB';
const PROJECT_1 = 'proj1';

function grantFor(roleKey: string, scopeType: RoleGrant['scopeType'], scopeId: string | null): RoleGrant {
  const definition = findRoleDefinition(roleKey);
  if (!definition) throw new Error(`Unknown role ${roleKey}`);
  return {
    roleId: `role-${roleKey}`,
    roleKey,
    roleName: definition.name,
    rank: definition.rank,
    scopeType,
    scopeId,
    permissions: definition.permissions,
    maxConfidentiality: definition.maxConfidentiality,
    companyWideRead: definition.companyWideRead,
  };
}

function actorWith(grants: RoleGrant[], overrides: Partial<Actor> = {}): Actor {
  const permissions = new Set<Permission>();
  for (const grant of grants) for (const permission of grant.permissions) permissions.add(permission);

  return {
    userId: 'user1',
    email: 'user@company.com',
    name: 'Test User',
    organizationId: ORG,
    departmentId: DEPT_A,
    projectIds: [PROJECT_1],
    isSuperAdmin: false,
    status: 'active',
    grants,
    permissions,
    roleKeys: grants.map((grant) => grant.roleKey),
    highestRank: grants.reduce((max, grant) => Math.max(max, grant.rank), 0),
    sessionId: 'session1',
    storageQuotaBytes: 0,
    storageUsedBytes: 0,
    ...overrides,
  };
}

const fileInDeptA: ResourceRef = {
  type: 'file',
  id: 'file1',
  organizationId: ORG,
  departmentId: DEPT_A,
  projectId: PROJECT_1,
  ownerId: 'someone-else',
  confidentiality: 'internal',
};

const fileInDeptB: ResourceRef = {
  ...fileInDeptA,
  id: 'file2',
  departmentId: DEPT_B,
  projectId: null,
};

describe('role scope resolution', () => {
  it('grants access within the scoped department', () => {
    const actor = actorWith([grantFor('research_scientist', 'department', DEPT_A)]);
    expect(can(actor, 'file.view', fileInDeptA)).toBe(true);
    expect(can(actor, 'file.download', fileInDeptA)).toBe(true);
  });

  /** The brief's headline requirement: departments must not leak into each other. */
  it('denies access to another department', () => {
    const actor = actorWith([grantFor('research_scientist', 'department', DEPT_A)]);
    expect(can(actor, 'file.view', fileInDeptB)).toBe(false);
    expect(canAccess(actor, 'file.view', fileInDeptB).allowed).toBe(false);
  });

  it('grants access through project membership', () => {
    const actor = actorWith([grantFor('data_analyst', 'project', PROJECT_1)], { departmentId: null });
    expect(can(actor, 'file.view', fileInDeptA)).toBe(true);
    expect(can(actor, 'file.view', { ...fileInDeptB, projectId: 'other-project' })).toBe(false);
  });

  it('company scope reaches everything in the organization', () => {
    const actor = actorWith([grantFor('company_admin', 'company', null)]);
    expect(can(actor, 'file.view', fileInDeptB)).toBe(true);
  });

  it('never reaches across organizations, even for a super admin', () => {
    const superAdmin = actorWith([], { isSuperAdmin: true });
    const foreign: ResourceRef = { ...fileInDeptA, organizationId: 'other-org' };
    expect(can(superAdmin, 'file.view', foreign)).toBe(false);
    expect(canAccess(superAdmin, 'file.view', foreign).allowed).toBe(false);
  });
});

describe('permission granularity', () => {
  it('Management Viewer can view but not download', () => {
    const actor = actorWith([grantFor('management_viewer', 'company', null)]);
    expect(can(actor, 'file.view', fileInDeptA)).toBe(true);
    expect(can(actor, 'file.download', fileInDeptA)).toBe(false);
    expect(can(actor, 'file.upload', fileInDeptA)).toBe(false);
  });

  it('Lab Technician cannot approve', () => {
    const actor = actorWith([grantFor('lab_technician', 'department', DEPT_A)]);
    expect(can(actor, 'file.upload', fileInDeptA)).toBe(true);
    expect(can(actor, 'review.approve', fileInDeptA)).toBe(false);
    expect(can(actor, 'resource.delete', fileInDeptA)).toBe(false);
  });

  it('Reviewer can review but not upload', () => {
    const actor = actorWith([grantFor('reviewer', 'department', DEPT_A)]);
    expect(can(actor, 'review.perform', fileInDeptA)).toBe(true);
    expect(can(actor, 'file.upload', fileInDeptA)).toBe(false);
    expect(can(actor, 'review.approve', fileInDeptA)).toBe(false);
  });
});

describe('confidentiality gate', () => {
  it('Management Viewer cannot reach confidential files', () => {
    const actor = actorWith([grantFor('management_viewer', 'company', null)]);
    expect(can(actor, 'file.view', { ...fileInDeptA, confidentiality: 'confidential' })).toBe(false);
    expect(can(actor, 'file.view', { ...fileInDeptA, confidentiality: 'internal' })).toBe(true);
  });

  /** Restricted requires an explicit grant — role scope alone is never enough. */
  it('restricted files are unreachable through role scope alone', () => {
    const restricted: ResourceRef = { ...fileInDeptA, confidentiality: 'restricted' };

    for (const roleKey of ['company_admin', 'rd_head', 'department_head', 'research_scientist']) {
      const actor = actorWith([grantFor(roleKey, roleKey === 'company_admin' ? 'company' : 'department', roleKey === 'company_admin' ? null : DEPT_A)]);
      expect(can(actor, 'file.view', restricted), roleKey).toBe(false);
    }
  });

  it('an explicit ACL entry does reach a restricted file', () => {
    const actor = actorWith([grantFor('research_scientist', 'department', DEPT_A)]);
    const restricted: ResourceRef = {
      ...fileInDeptA,
      confidentiality: 'restricted',
      acl: [{ principalType: 'user', principalId: actor.userId, accessLevel: 'viewer' }],
    };
    expect(can(actor, 'file.view', restricted)).toBe(true);
  });
});

describe('ACLs, ownership and inheritance', () => {
  it('an explicit deny beats every allow, including for a super admin', () => {
    const superAdmin = actorWith([], { isSuperAdmin: true });
    const denied: ResourceRef = {
      ...fileInDeptA,
      acl: [{ principalType: 'user', principalId: superAdmin.userId, accessLevel: 'viewer', deny: true }],
    };
    expect(can(superAdmin, 'file.view', denied)).toBe(false);
  });

  it('honours an expired share as if it were absent', () => {
    const actor = actorWith([]);
    const expired: ResourceRef = {
      ...fileInDeptA,
      departmentId: DEPT_B,
      acl: [
        {
          principalType: 'user',
          principalId: actor.userId,
          accessLevel: 'viewer',
          expiresAt: new Date(Date.now() - 1000),
        },
      ],
    };
    expect(can(actor, 'file.view', expired)).toBe(false);
  });

  it('owners can act on their own content without a role grant', () => {
    const actor = actorWith([]);
    const own: ResourceRef = { ...fileInDeptA, ownerId: actor.userId };
    expect(can(actor, 'file.view', own)).toBe(true);
    expect(can(actor, 'metadata.edit', own)).toBe(true);
    // Ownership is deliberately not a route to approving your own work.
    expect(can(actor, 'review.approve', own)).toBe(false);
  });

  it('inherits an allow from an ancestor folder', () => {
    const actor = actorWith([]);
    const file: ResourceRef = { ...fileInDeptA, departmentId: DEPT_B, inheritPermissions: true };
    const decision = canAccess(actor, 'file.view', file, {
      ancestorAcls: [
        {
          folderId: 'root',
          acl: [{ principalType: 'user', principalId: actor.userId, accessLevel: 'viewer' }],
          inheritPermissions: true,
        },
      ],
    });
    expect(decision).toEqual({ allowed: true, reason: 'inherited_acl' });
  });

  it('stops inheriting when a file breaks inheritance', () => {
    const actor = actorWith([]);
    const file: ResourceRef = { ...fileInDeptA, departmentId: DEPT_B, inheritPermissions: false };
    const decision = canAccess(actor, 'file.view', file, {
      ancestorAcls: [
        {
          folderId: 'root',
          acl: [{ principalType: 'user', principalId: actor.userId, accessLevel: 'viewer' }],
          inheritPermissions: true,
        },
      ],
    });
    expect(decision.allowed).toBe(false);
  });
});

describe('actor status and deleted resources', () => {
  it('a deactivated actor can do nothing at all', () => {
    const actor = actorWith([grantFor('company_admin', 'company', null)], { status: 'deactivated' });
    expect(can(actor, 'file.view', fileInDeptA)).toBe(false);
    expect(() => assertCompanyPermission(actor, 'user.manage')).toThrow(ForbiddenError);
  });

  it('trashed resources only answer to restore', () => {
    const actor = actorWith([grantFor('company_admin', 'company', null)]);
    const trashed: ResourceRef = { ...fileInDeptA, status: 'trashed' };
    expect(can(actor, 'file.download', trashed)).toBe(false);
    expect(can(actor, 'resource.restore', trashed)).toBe(true);
  });
});

describe('assertCan error mapping', () => {
  it('throws 404 (not 403) for a resource the actor cannot see', () => {
    const actor = actorWith([grantFor('research_scientist', 'department', DEPT_A)]);
    // Wrong organization → invisible → NotFound, so the id is not confirmed to exist.
    expect(() => assertCan(actor, 'file.view', { ...fileInDeptA, organizationId: 'other' })).toThrow(
      NotFoundError,
    );
  });

  it('throws 403 when the resource is visible but the action is not permitted', () => {
    const actor = actorWith([grantFor('management_viewer', 'company', null)]);
    expect(() => assertCan(actor, 'file.download', fileInDeptA)).toThrow(ForbiddenError);
  });

  it('throws 404 for any action on a resource in another department', () => {
    const actor = actorWith([grantFor('research_scientist', 'department', DEPT_A)]);
    // The oracle this closes: 403 for a real id and 404 for an invented one would let
    // anyone enumerate which file ids exist. Every action on something the actor cannot
    // even view answers the same way as a file that is not there at all.
    expect(can(actor, 'file.view', fileInDeptB)).toBe(false);
    for (const permission of [
      'file.view',
      'file.download',
      'file.preview',
      'file.upload',
      'resource.rename',
      'resource.delete',
      'access.manage',
    ] as Permission[]) {
      expect(() => assertCan(actor, permission, fileInDeptB), permission).toThrow(NotFoundError);
    }
  });

  it('still throws 404 rather than 403 for an explicitly denied resource', () => {
    const actor = actorWith([grantFor('research_scientist', 'department', DEPT_A)]);
    const denied: ResourceRef = {
      ...fileInDeptA,
      acl: [{ principalType: 'user', principalId: 'user1', accessLevel: 'viewer', deny: true }],
    };
    expect(() => assertCan(actor, 'file.download', denied)).toThrow(NotFoundError);
  });
});

describe('privilege escalation guards', () => {
  const departmentHead = actorWith([grantFor('department_head', 'department', DEPT_A)]);

  it('refuses to grant a role at or above your own rank', () => {
    const companyAdmin = findRoleDefinition('company_admin')!;
    expect(() => assertCanGrantRole(departmentHead, companyAdmin)).toThrow(ForbiddenError);

    const sameRank = findRoleDefinition('department_head')!;
    expect(() => assertCanGrantRole(departmentHead, sameRank)).toThrow(ForbiddenError);
  });

  it('allows granting a lower-ranked role whose permissions you hold', () => {
    const technician = findRoleDefinition('lab_technician')!;
    expect(() => assertCanGrantRole(departmentHead, technician)).not.toThrow();
  });

  it('refuses to grant a permission the actor does not hold', () => {
    const viewerOnly = actorWith([grantFor('management_viewer', 'company', null)]);
    const scientist = findRoleDefinition('research_scientist')!;
    expect(() => assertCanGrantRole(viewerOnly, scientist)).toThrow(ForbiddenError);
  });

  it('a super admin may grant anything', () => {
    const superAdmin = actorWith([], { isSuperAdmin: true });
    for (const role of DEFAULT_ROLES) {
      expect(() => assertCanGrantRole(superAdmin, role)).not.toThrow();
    }
  });
});

describe('company-scope administrative checks', () => {
  it('requires a company-scope grant, not merely the permission', () => {
    const departmentHead = actorWith([grantFor('department_head', 'department', DEPT_A)]);
    // Department Head holds user.manage — but only within their department.
    expect(departmentHead.permissions.has('user.manage')).toBe(true);
    expect(() => assertCompanyPermission(departmentHead, 'user.manage')).toThrow(ForbiddenError);

    const companyAdmin = actorWith([grantFor('company_admin', 'company', null)]);
    expect(() => assertCompanyPermission(companyAdmin, 'user.manage')).not.toThrow();
  });
});
