/**
 * The project-drive gate (`canSeeProject`) and the listing input (`visibleProjectsInput`) must
 * apply the same classification rule, or a project hidden from the list for being above the
 * actor's clearance would still open by id. The listing itself is pinned on both engines in
 * `tests/d1/project-experiment-repository.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import type { Actor, RoleGrant } from '@/server/permissions/actor';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import { canSeeProject, visibleProjectsInput } from '@/server/permissions/project-visibility';

const MOLBIO = 'dept-molbio';
const OTHER = 'dept-other';

function grant(overrides: Partial<RoleGrant>): RoleGrant {
  return {
    roleId: 'role',
    roleKey: 'lab_technician',
    roleName: 'Lab Technician',
    rank: 10,
    scopeType: 'department',
    scopeId: MOLBIO,
    permissions: ['file.view'],
    maxConfidentiality: 'internal',
    companyWideRead: false,
    ...overrides,
  };
}

function actor(grants: RoleGrant[], overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 'carol',
    email: 'carol@company.com',
    name: 'Carol',
    organizationId: 'org',
    departmentId: OTHER,
    projectIds: [],
    isSuperAdmin: false,
    status: 'active',
    grants,
    permissions: new Set(),
    roleKeys: grants.map((g) => g.roleKey),
    highestRank: 10,
    sessionId: 'session',
    storageQuotaBytes: 0,
    storageUsedBytes: 0,
    ...overrides,
  };
}

function project(confidentiality: ConfidentialityLevel, members: string[] = []) {
  return { id: 'p1', departmentId: MOLBIO, memberUserIds: members, leadUserId: null, confidentiality };
}

describe('canSeeProject', () => {
  const technician = actor([grant({})]);

  it('lets a department grant in within clearance', () => {
    expect(canSeeProject(technician, project('internal'))).toBe(true);
  });

  it('keeps a department grant out above clearance', () => {
    expect(canSeeProject(technician, project('confidential'))).toBe(false);
  });

  it('lets a member in at any classification', () => {
    expect(canSeeProject(technician, project('restricted', ['carol']))).toBe(true);
  });

  it('never reaches restricted by role scope, even for a company-wide reader', () => {
    const reader = actor([grant({ scopeType: 'company', scopeId: null, companyWideRead: true, maxConfidentiality: 'confidential' })]);
    expect(canSeeProject(reader, project('confidential'))).toBe(true);
    expect(canSeeProject(reader, project('restricted'))).toBe(false);
  });

  it('refuses a grant for another department', () => {
    const elsewhere = actor([grant({ scopeId: OTHER, maxConfidentiality: 'confidential' })]);
    expect(canSeeProject(elsewhere, project('internal'))).toBe(false);
  });

  it('agrees with the listing input on clearance', () => {
    expect(visibleProjectsInput(technician).clearance).toEqual(['public_internal', 'internal']);
    expect(visibleProjectsInput(actor([], { isSuperAdmin: true })).clearance).toContain('restricted');
  });
});
