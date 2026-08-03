/**
 * Deterministic fixture used by the integration and security suites:
 * one organization, two departments, the system roles, and employees covering the
 * roles the tests reason about.
 */
import { Types } from 'mongoose';

import {
  DepartmentModel,
  OrganizationModel,
  RoleModel,
  UserModel,
  UserRoleModel,
} from '@/server/db/models';
import { DEFAULT_ROLES } from '@/server/domain/roles';
import { hashPassword } from '@/server/auth/password';
import type { Actor } from '@/server/permissions/actor';

export const TEST_PASSWORD = 'Fixture-Passw0rd!2026';
export const TEST_DOMAINS = ['company.com'];

export interface Fixture {
  organizationId: string;
  departments: { molbio: string; anchem: string };
  roleIds: Record<string, string>;
  users: {
    superAdmin: string;
    companyAdmin: string;
    deptAHead: string;
    scientistA: string;
    scientistB: string;
    viewer: string;
    noRole: string;
    /** Company-scoped inventory administrator — full control of every store. */
    inventoryAdmin: string;
    /** Department-scoped store manager for MOLBIO — may receive and issue, nothing else. */
    storeManager: string;
  };
}

async function createUser(input: {
  organizationId: Types.ObjectId;
  email: string;
  name: string;
  departmentId?: Types.ObjectId | null;
  isSuperAdmin?: boolean;
  status?: 'active' | 'invited' | 'deactivated';
  passwordHash: string;
}): Promise<string> {
  const user = await UserModel.create({
    organizationId: input.organizationId,
    email: input.email,
    emailDomain: input.email.split('@')[1]!,
    name: input.name,
    status: input.status ?? 'active',
    isSuperAdmin: input.isSuperAdmin ?? false,
    departmentId: input.departmentId ?? null,
    storageQuotaBytes: 20 * 1024 ** 3,
    passwordHash: input.passwordHash,
    passwordUpdatedAt: new Date(Date.now() - 60_000),
    activatedAt: new Date(),
    authProviders: [{ provider: 'password' }],
  });
  return String(user._id);
}

export async function seedFixture(): Promise<Fixture> {
  const organization = await OrganizationModel.create({
    name: 'Company Research',
    slug: 'company',
    emailDomains: TEST_DOMAINS,
    settings: {
      allowAutoProvisioning: false,
      defaultUserQuotaBytes: 20 * 1024 ** 3,
      defaultDepartmentQuotaBytes: 500 * 1024 ** 3,
      maxUploadBytes: 2048 * 1024 ** 2,
    },
  });
  const organizationId = organization._id;

  const roleIds: Record<string, string> = {};
  for (const definition of DEFAULT_ROLES) {
    const role = await RoleModel.create({
      organizationId,
      key: definition.key,
      name: definition.name,
      description: definition.description,
      permissions: definition.permissions,
      scopeTypes: definition.scopeTypes,
      rank: definition.rank,
      maxConfidentiality: definition.maxConfidentiality,
      companyWideRead: definition.companyWideRead,
      isSystem: true,
    });
    roleIds[definition.key] = String(role._id);
  }

  const molbio = await DepartmentModel.create({
    organizationId,
    name: 'Molecular Biology',
    code: 'MOLBIO',
    storageQuotaBytes: 500 * 1024 ** 3,
  });
  const anchem = await DepartmentModel.create({
    organizationId,
    name: 'Analytical Chemistry',
    code: 'ANCHEM',
    storageQuotaBytes: 500 * 1024 ** 3,
  });

  // Hashing is deliberately slow, so every fixture user shares one hash.
  const passwordHash = await hashPassword(TEST_PASSWORD);

  const users = {
    superAdmin: await createUser({
      organizationId,
      email: 'root@company.com',
      name: 'Root Admin',
      isSuperAdmin: true,
      passwordHash,
    }),
    companyAdmin: await createUser({
      organizationId,
      email: 'admin@company.com',
      name: 'Company Admin',
      passwordHash,
    }),
    deptAHead: await createUser({
      organizationId,
      email: 'head.molbio@company.com',
      name: 'Molbio Head',
      departmentId: molbio._id,
      passwordHash,
    }),
    scientistA: await createUser({
      organizationId,
      email: 'alice@company.com',
      name: 'Alice Scientist',
      departmentId: molbio._id,
      passwordHash,
    }),
    scientistB: await createUser({
      organizationId,
      email: 'bob@company.com',
      name: 'Bob Scientist',
      departmentId: anchem._id,
      passwordHash,
    }),
    viewer: await createUser({
      organizationId,
      email: 'exec@company.com',
      name: 'Exec Viewer',
      passwordHash,
    }),
    noRole: await createUser({
      organizationId,
      email: 'newcomer@company.com',
      name: 'New Comer',
      departmentId: molbio._id,
      passwordHash,
    }),
    inventoryAdmin: await createUser({
      organizationId,
      email: 'stores@company.com',
      name: 'Inventory Admin',
      passwordHash,
    }),
    storeManager: await createUser({
      organizationId,
      email: 'store.molbio@company.com',
      name: 'Molbio Store Manager',
      departmentId: molbio._id,
      passwordHash,
    }),
  };

  const grants: Array<[string, string, 'company' | 'department', Types.ObjectId | null]> = [
    [users.superAdmin, 'super_admin', 'company', null],
    [users.companyAdmin, 'company_admin', 'company', null],
    [users.deptAHead, 'department_head', 'department', molbio._id],
    [users.scientistA, 'research_scientist', 'department', molbio._id],
    [users.scientistB, 'research_scientist', 'department', anchem._id],
    [users.viewer, 'management_viewer', 'company', null],
    [users.inventoryAdmin, 'inventory_admin', 'company', null],
    // Department scope on purpose: the inventory suites need somebody who may change one
    // department's stock and must be refused on another's.
    [users.storeManager, 'store_manager', 'department', molbio._id],
  ];

  for (const [userId, roleKey, scopeType, scopeId] of grants) {
    await UserRoleModel.create({
      organizationId,
      userId: new Types.ObjectId(userId),
      roleId: new Types.ObjectId(roleIds[roleKey]!),
      scopeType,
      scopeId,
      grantedAt: new Date(),
    });
  }

  return {
    organizationId: String(organizationId),
    departments: { molbio: String(molbio._id), anchem: String(anchem._id) },
    roleIds,
    users,
  };
}

export const TEST_META = {
  requestId: 'test-request',
  ip: '10.0.0.1',
  userAgent: 'vitest',
};

/**
 * Builds the Actor a service would receive for a fixture user.
 *
 * Deliberately assembled from the repositories rather than hand-written, so a test can
 * never grant itself a permission the real login path would not produce.
 */
export async function actorFor(userId: string): Promise<Actor> {
  const userRepository = await import('@/server/repositories/user.repository');
  const roleRepository = await import('@/server/repositories/role.repository');

  const user = await userRepository.findById(userId);
  if (!user) throw new Error(`fixture user ${userId} not found`);

  const grants = await roleRepository.getActorGrants(userId);
  const permissions = new Set(grants.flatMap((grant) => grant.permissions));

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    organizationId: user.organizationId,
    departmentId: user.departmentId,
    projectIds: user.projectIds,
    isSuperAdmin: user.isSuperAdmin,
    status: user.status,
    grants,
    permissions,
    roleKeys: grants.map((grant) => grant.roleKey),
    highestRank: grants.reduce((max, grant) => Math.max(max, grant.rank), 0),
    sessionId: 'test-session',
    storageQuotaBytes: user.storageQuotaBytes,
    storageUsedBytes: user.storageUsedBytes,
  };
}
