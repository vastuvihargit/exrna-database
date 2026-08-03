/**
 * Employee management authorization — the escalation and cross-department cases that
 * a permission matrix on paper does not prove.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { seedFixture, TEST_META, type Fixture } from '../helpers/fixtures';
import type { Actor } from '@/server/permissions/actor';

let db: TestDb;
let fixture: Fixture;

async function actorFor(userId: string): Promise<Actor> {
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

beforeAll(async () => {
  db = await startTestDb();
  if (db.available) fixture = await seedFixture();
}, 180_000);

afterAll(async () => {
  if (db?.available) await stopTestDb();
});

describe('employee creation', () => {
  it('refuses to create an account on a personal email domain', async () => {
    if (!db.available) {
      expect(db.reason, 'in-memory MongoDB unavailable').toBeTruthy();
      return;
    }
    const { userService } = await import('@/server/services/user.service');
    const admin = await actorFor(fixture.users.companyAdmin);

    await expect(
      userService.createEmployee(admin, { email: 'someone@gmail.com', name: 'Outsider' }, TEST_META),
    ).rejects.toThrow(/company domain/i);
  }, 60_000);

  it('creates an employee and records it in the audit log', async () => {
    if (!db.available) return;
    const { userService } = await import('@/server/services/user.service');
    const { AuditLogModel } = await import('@/server/db/models');

    const admin = await actorFor(fixture.users.companyAdmin);
    const created = await userService.createEmployee(
      admin,
      { email: 'newhire@company.com', name: 'New Hire', departmentId: fixture.departments.molbio },
      TEST_META,
    );

    expect(created.email).toBe('newhire@company.com');
    // Created accounts start invited: they cannot sign in until activated.
    expect(created.status).toBe('invited');

    const entry = await AuditLogModel.findOne({ action: 'user.created', entityId: created.id }).lean();
    expect(entry?.actorEmail).toBe(admin.email);
  }, 60_000);

  it('rejects a duplicate email address', async () => {
    if (!db.available) return;
    const { userService } = await import('@/server/services/user.service');
    const admin = await actorFor(fixture.users.companyAdmin);

    await expect(
      userService.createEmployee(admin, { email: 'alice@company.com', name: 'Impostor' }, TEST_META),
    ).rejects.toThrow(/already exists/i);
  }, 60_000);

  it('an ordinary scientist cannot create employees', async () => {
    if (!db.available) return;
    const { userService } = await import('@/server/services/user.service');
    const scientist = await actorFor(fixture.users.scientistA);

    await expect(
      userService.createEmployee(scientist, { email: 'sneaky@company.com', name: 'Sneaky' }, TEST_META),
    ).rejects.toThrow();
  }, 60_000);
});

describe('department scoping', () => {
  it('a department head cannot manage another department’s employees', async () => {
    if (!db.available) return;
    const { userService } = await import('@/server/services/user.service');
    const head = await actorFor(fixture.users.deptAHead);

    // scientistB belongs to Analytical Chemistry; the head runs Molecular Biology.
    await expect(
      userService.setStatus(head, fixture.users.scientistB, 'deactivated', 'test', TEST_META),
    ).rejects.toThrow(/own department/i);
  }, 60_000);

  it('a department head can manage their own department’s employees', async () => {
    if (!db.available) return;
    const { userService } = await import('@/server/services/user.service');
    const head = await actorFor(fixture.users.deptAHead);

    const updated = await userService.setStatus(
      head,
      fixture.users.noRole,
      'active',
      null,
      TEST_META,
    );
    expect(updated.status).toBe('active');
  }, 60_000);
});

describe('privilege escalation', () => {
  it('a department head cannot grant a company-admin role', async () => {
    if (!db.available) return;
    const { userService } = await import('@/server/services/user.service');
    const head = await actorFor(fixture.users.deptAHead);

    await expect(
      userService.grantRole(
        head,
        { userId: fixture.users.noRole, roleKey: 'company_admin', scopeType: 'company', scopeId: null },
        TEST_META,
      ),
    ).rejects.toThrow(/privilege level/i);
  }, 60_000);

  it('a scientist cannot grant themselves any role', async () => {
    if (!db.available) return;
    const { userService } = await import('@/server/services/user.service');
    const scientist = await actorFor(fixture.users.scientistA);

    await expect(
      userService.grantRole(
        scientist,
        {
          userId: scientist.userId,
          roleKey: 'company_admin',
          scopeType: 'company',
          scopeId: null,
        },
        TEST_META,
      ),
    ).rejects.toThrow();
  }, 60_000);

  it('nobody can deactivate their own account', async () => {
    if (!db.available) return;
    const { userService } = await import('@/server/services/user.service');
    const admin = await actorFor(fixture.users.companyAdmin);

    await expect(
      userService.setStatus(admin, admin.userId, 'deactivated', 'oops', TEST_META),
    ).rejects.toThrow(/your own account/i);
  }, 60_000);

  it('the last active super administrator cannot be deactivated', async () => {
    if (!db.available) return;
    const { userService } = await import('@/server/services/user.service');
    const root = await actorFor(fixture.users.superAdmin);

    await expect(
      userService.setStatus(root, fixture.users.superAdmin, 'deactivated', 'test', TEST_META),
    ).rejects.toThrow();
  }, 60_000);

  it('requires a reason before deactivating anyone', async () => {
    if (!db.available) return;
    const { userService } = await import('@/server/services/user.service');
    const admin = await actorFor(fixture.users.companyAdmin);

    await expect(
      userService.setStatus(admin, fixture.users.scientistB, 'deactivated', null, TEST_META),
    ).rejects.toThrow(/reason is required/i);
  }, 60_000);
});

describe('role grants take effect immediately', () => {
  it('granting a role revokes the target’s existing sessions', async () => {
    if (!db.available) return;

    const { authService } = await import('@/server/services/auth.service');
    const { resolveSession } = await import('@/server/auth/session.service');
    const { userService } = await import('@/server/services/user.service');
    const { UserModel } = await import('@/server/db/models');
    const { resetAllRateLimits } = await import('@/server/auth/rate-limit');
    const { TEST_PASSWORD } = await import('../helpers/fixtures');

    await UserModel.updateOne({ _id: fixture.users.noRole }, { $set: { status: 'active' } });
    resetAllRateLimits();

    const session = await authService.loginWithPassword(
      { email: 'newcomer@company.com', password: TEST_PASSWORD },
      TEST_META,
    );
    expect(await resolveSession(session.token)).not.toBeNull();

    const admin = await actorFor(fixture.users.companyAdmin);
    await userService.grantRole(
      admin,
      {
        userId: fixture.users.noRole,
        roleKey: 'research_scientist',
        scopeType: 'department',
        scopeId: fixture.departments.molbio,
      },
      TEST_META,
    );

    // Old session is gone; the next sign-in carries the new permissions.
    expect(await resolveSession(session.token)).toBeNull();

    resetAllRateLimits();
    const refreshed = await authService.loginWithPassword(
      { email: 'newcomer@company.com', password: TEST_PASSWORD },
      TEST_META,
    );
    const actor = (await resolveSession(refreshed.token))!.actor;
    expect(actor.roleKeys).toContain('research_scientist');
    expect(actor.permissions.has('file.upload')).toBe(true);
  }, 180_000);
});

describe('directory exposure', () => {
  it('the employee directory exposes identity only, never status or quota', async () => {
    if (!db.available) return;
    const { userService } = await import('@/server/services/user.service');
    const scientist = await actorFor(fixture.users.scientistA);

    const { items } = await userService.listDirectory(scientist, { page: 1, pageSize: 10 });
    expect(items.length).toBeGreaterThan(0);

    for (const entry of items) {
      expect(Object.keys(entry).sort()).toEqual(
        ['avatarUrl', 'departmentId', 'email', 'id', 'jobTitle', 'name'].sort(),
      );
    }
  }, 60_000);

  it('an ordinary employee cannot use the administrative listing', async () => {
    if (!db.available) return;
    const { userService } = await import('@/server/services/user.service');
    const scientist = await actorFor(fixture.users.scientistA);

    await expect(userService.listForAdmin(scientist, { page: 1, pageSize: 10 })).rejects.toThrow();
  }, 60_000);
});
