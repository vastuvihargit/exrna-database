/**
 * Phase 3, module 2 — roles and permissions.
 *
 * Same structure as the module 1 suite: both engines run the same assertions, a parity block
 * proves they agree field for field, and a D1 block covers what only SQL can get wrong.
 *
 * This module decides what every authenticated request is allowed to do, so the assertions
 * that matter most are the negative ones — a revoked grant confers nothing, an expired grant
 * confers nothing, a grant belonging to somebody else is never returned, and a duplicate
 * company-scope grant cannot exist.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestDb, stopTestDb, clearCollections } from '../helpers/test-db';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import { d1RoleRepository, mongoRoleRepository } from '@/server/repositories/role.repository';
import * as roleFacade from '@/server/repositories/role.repository';
import type {
  GrantSummary,
  RoleRecord,
  RoleRepository,
} from '@/server/repositories/role.repository.contract';
import type { RoleGrant } from '@/server/permissions/actor';
import type { Permission, ScopeType } from '@/server/domain/permissions';
import { clearDataSourceOverrides, setDataSourceOverride } from '@/server/repositories/data-source';

const ORG_A = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';
const ISO = '2026-01-01T00:00:00.000Z';

/** Fixed ids, so the two databases can be given identical worlds and compared directly. */
const ALICE = '507f1f77bcf86cd799439031';
const BOB = '507f1f77bcf86cd799439032';
const ADMIN = '507f1f77bcf86cd799439033';
const DEPARTMENT = '507f1f77bcf86cd799439041';

let d1: D1Database;

interface Engine {
  name: 'mongo' | 'd1';
  roles: RoleRepository;
  reset: () => Promise<void>;
  createRole: (input: SeedRole) => Promise<string>;
}

interface SeedRole {
  id: string;
  key: string;
  name: string;
  rank: number;
  permissions: Permission[];
  scopeTypes: ScopeType[];
  maxConfidentiality?: 'public_internal' | 'internal' | 'confidential' | 'restricted';
  companyWideRead?: boolean;
  isSystem?: boolean;
  organizationId?: string;
}

/* ------------------------------------------------------------------ seeding */

async function seedD1World(): Promise<void> {
  for (const id of [ORG_A, ORG_B]) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO organizations
           (id, name, slug, email_domains, settings, storage_used_bytes, file_count, is_active, created_at, updated_at)
         VALUES (?, ?, ?, '[]', '{}', 0, 0, 1, ?, ?)`,
      )
      .bind(id, `Org ${id.slice(-2)}`, `org-${id.slice(-2)}`, ISO, ISO)
      .run();
  }

  for (const [id, email] of [
    [ALICE, 'alice@company.com'],
    [BOB, 'bob@company.com'],
    [ADMIN, 'admin@company.com'],
  ] as const) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO users
           (id, organization_id, email, email_domain, name, mfa, preferences, status,
            is_super_admin, storage_quota_bytes, storage_used_bytes, must_change_password,
            failed_login_count, created_at, updated_at)
         VALUES (?, ?, ?, 'company.com', ?, '{"enabled":false}', '{}', 'active', 0, 1, 0, 0, 0, ?, ?)`,
      )
      .bind(id, ORG_A, email, email.split('@')[0], ISO, ISO)
      .run();
  }
}

async function createD1Role(input: SeedRole): Promise<string> {
  await d1
    .prepare(
      `INSERT INTO roles
         (id, organization_id, key, name, description, rank, max_confidentiality,
          company_wide_read, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.organizationId ?? ORG_A,
      input.key.toLowerCase(),
      input.name,
      input.rank,
      input.maxConfidentiality ?? 'internal',
      input.companyWideRead ? 1 : 0,
      input.isSystem ? 1 : 0,
      ISO,
      ISO,
    )
    .run();

  for (const permission of input.permissions) {
    await d1
      .prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)')
      .bind(input.id, permission)
      .run();
  }
  for (const scopeType of input.scopeTypes) {
    await d1
      .prepare('INSERT INTO role_scope_types (role_id, scope_type) VALUES (?, ?)')
      .bind(input.id, scopeType)
      .run();
  }
  return input.id;
}

async function createMongoRole(input: SeedRole): Promise<string> {
  const { RoleModel } = await import('@/server/db/models');
  const { Types } = await import('mongoose');
  const doc = await RoleModel.create({
    _id: new Types.ObjectId(input.id),
    organizationId: new Types.ObjectId(input.organizationId ?? ORG_A),
    key: input.key,
    name: input.name,
    description: '',
    permissions: input.permissions,
    scopeTypes: input.scopeTypes,
    rank: input.rank,
    maxConfidentiality: input.maxConfidentiality ?? 'internal',
    companyWideRead: input.companyWideRead ?? false,
    isSystem: input.isSystem ?? false,
  });
  return String(doc._id);
}

/* ------------------------------------------------------------------ harness */

beforeAll(async () => {
  const mongo = await startTestDb();
  if (!mongo.available) {
    throw new Error(
      `This suite asserts that the MongoDB and D1 role repositories agree, so it needs both. ` +
        `MongoDB could not start: ${mongo.reason}`,
    );
  }
  d1 = await startTestD1();
  setD1BindingForTesting(d1);
  await seedD1World();
}, 300_000);

afterAll(async () => {
  setD1BindingForTesting(null);
  clearDataSourceOverrides();
  await stopTestD1();
  await stopTestDb();
});

/** `user_roles` and `role_permissions` reference roles, so children go first. */
const D1_RESET = [
  'DELETE FROM user_roles',
  'DELETE FROM role_permissions',
  'DELETE FROM role_scope_types',
  'DELETE FROM roles',
];

const ENGINES: Engine[] = [
  {
    name: 'mongo',
    roles: mongoRoleRepository,
    reset: () => clearCollections(),
    createRole: createMongoRole,
  },
  {
    name: 'd1',
    roles: d1RoleRepository,
    reset: async () => {
      await clearD1(d1, D1_RESET);
      await seedD1World();
    },
    createRole: createD1Role,
  },
];

const ADMIN_ROLE: SeedRole = {
  id: '507f1f77bcf86cd799439051',
  key: 'administrator',
  name: 'Administrator',
  rank: 90,
  permissions: ['user.manage', 'audit.view', 'file.view'],
  scopeTypes: ['company', 'department'],
  companyWideRead: true,
  maxConfidentiality: 'restricted',
  isSystem: true,
};

const SCIENTIST_ROLE: SeedRole = {
  id: '507f1f77bcf86cd799439052',
  key: 'scientist',
  name: 'Scientist',
  rank: 40,
  permissions: ['file.view', 'file.upload', 'comment.create'],
  scopeTypes: ['department', 'project'],
};

const VIEWER_ROLE: SeedRole = {
  id: '507f1f77bcf86cd799439053',
  key: 'viewer',
  name: 'Viewer',
  rank: 10,
  permissions: ['file.view'],
  scopeTypes: ['project'],
};

/* ------------------------------------------------------------------ comparators */

function sortedRole(role: RoleRecord): Record<string, unknown> {
  return {
    ...role,
    permissions: [...role.permissions].sort(),
    scopeTypes: [...role.scopeTypes].sort(),
  };
}

function comparableGrant(grant: RoleGrant): Record<string, unknown> {
  return { ...grant, permissions: [...grant.permissions].sort() };
}

function comparableSummary(summary: GrantSummary): Record<string, unknown> {
  return {
    ...summary,
    id: '<grant>',
    grantedAt: summary.grantedAt instanceof Date ? '<Date>' : '<not-a-Date>',
    expiresAt:
      summary.expiresAt === null
        ? null
        : summary.expiresAt instanceof Date
          ? '<Date>'
          : '<not-a-Date>',
  };
}

/* ================================================================== per-engine */

describe.each(ENGINES)('$name role repository', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  describe('roles', () => {
    it('lists roles by descending rank', async () => {
      await engine.createRole(VIEWER_ROLE);
      await engine.createRole(ADMIN_ROLE);
      await engine.createRole(SCIENTIST_ROLE);

      const list = await engine.roles.listRoles(ORG_A);
      expect(list.map((role) => role.key)).toEqual(['administrator', 'scientist', 'viewer']);
    });

    it('never returns a role from another organization', async () => {
      await engine.createRole(ADMIN_ROLE);
      await engine.createRole({ ...VIEWER_ROLE, organizationId: ORG_B });

      const list = await engine.roles.listRoles(ORG_A);
      expect(list.map((role) => role.key)).toEqual(['administrator']);
    });

    it('round-trips permissions and scope types', async () => {
      await engine.createRole(ADMIN_ROLE);
      const role = await engine.roles.findRoleById(ADMIN_ROLE.id);

      expect([...role!.permissions].sort()).toEqual(
        ['audit.view', 'file.view', 'user.manage'].sort(),
      );
      expect([...role!.scopeTypes].sort()).toEqual(['company', 'department']);
      expect(role!.rank).toBe(90);
      expect(role!.companyWideRead).toBe(true);
      expect(role!.maxConfidentiality).toBe('restricted');
      expect(role!.isSystem).toBe(true);
    });

    it('finds a role by key, case-insensitively', async () => {
      await engine.createRole(ADMIN_ROLE);
      expect((await engine.roles.findRoleByKey(ORG_A, 'ADMINISTRATOR'))?.key).toBe('administrator');
      expect(await engine.roles.findRoleByKey(ORG_A, 'nope')).toBeNull();
    });

    it('returns null and empty rather than throwing for unknown ids', async () => {
      expect(await engine.roles.findRoleById('507f1f77bcf86cd799439099')).toBeNull();
      expect(await engine.roles.findRolesByIds([])).toEqual([]);
      expect(await engine.roles.listRoles(ORG_B)).toEqual([]);
    });
  });

  describe('grants — what they confer', () => {
    beforeEach(async () => {
      await engine.createRole(ADMIN_ROLE);
      await engine.createRole(SCIENTIST_ROLE);
    });

    it('resolves a company-scope grant into the role permissions', async () => {
      await engine.roles.grantRole({
        organizationId: ORG_A,
        userId: ALICE,
        roleId: ADMIN_ROLE.id,
        scopeType: 'company',
        scopeId: null,
        grantedBy: ADMIN,
      });

      const grants = await engine.roles.getActorGrants(ALICE);
      expect(grants).toHaveLength(1);
      expect(grants[0]!.roleKey).toBe('administrator');
      expect(grants[0]!.scopeId).toBeNull();
      expect([...grants[0]!.permissions].sort()).toEqual(
        ['audit.view', 'file.view', 'user.manage'].sort(),
      );
      expect(grants[0]!.companyWideRead).toBe(true);
      expect(grants[0]!.rank).toBe(90);
    });

    it('never returns another user’s grants', async () => {
      await engine.roles.grantRole({
        organizationId: ORG_A,
        userId: ALICE,
        roleId: ADMIN_ROLE.id,
        scopeType: 'company',
        scopeId: null,
        grantedBy: ADMIN,
      });

      expect(await engine.roles.getActorGrants(BOB)).toEqual([]);
      expect(await engine.roles.listGrantsForUser(BOB)).toEqual([]);
    });

    it('a revoked grant confers nothing', async () => {
      const grantId = await engine.roles.grantRole({
        organizationId: ORG_A,
        userId: ALICE,
        roleId: ADMIN_ROLE.id,
        scopeType: 'company',
        scopeId: null,
        grantedBy: ADMIN,
      });

      expect(await engine.roles.getActorGrants(ALICE)).toHaveLength(1);
      expect(await engine.roles.revokeGrant(grantId, ADMIN)).toBe(true);
      expect(await engine.roles.getActorGrants(ALICE)).toEqual([]);
      expect(await engine.roles.listGrantsForUser(ALICE)).toEqual([]);
    });

    it('revoking twice reports false the second time', async () => {
      const grantId = await engine.roles.grantRole({
        organizationId: ORG_A,
        userId: ALICE,
        roleId: ADMIN_ROLE.id,
        scopeType: 'company',
        scopeId: null,
        grantedBy: ADMIN,
      });

      expect(await engine.roles.revokeGrant(grantId, ADMIN)).toBe(true);
      expect(await engine.roles.revokeGrant(grantId, ADMIN)).toBe(false);
    });

    it('an expired grant confers nothing but stays on the administrative list', async () => {
      await engine.roles.grantRole({
        organizationId: ORG_A,
        userId: ALICE,
        roleId: ADMIN_ROLE.id,
        scopeType: 'company',
        scopeId: null,
        grantedBy: ADMIN,
        expiresAt: new Date(Date.now() - 60_000),
      });

      // The permission path excludes it …
      expect(await engine.roles.getActorGrants(ALICE)).toEqual([]);
      // … the administrative view still shows it. These two differ on purpose.
      expect(await engine.roles.listGrantsForUser(ALICE)).toHaveLength(1);
    });

    it('a grant expiring in the future still confers', async () => {
      await engine.roles.grantRole({
        organizationId: ORG_A,
        userId: ALICE,
        roleId: SCIENTIST_ROLE.id,
        scopeType: 'department',
        scopeId: DEPARTMENT,
        grantedBy: ADMIN,
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const grants = await engine.roles.getActorGrants(ALICE);
      expect(grants).toHaveLength(1);
      expect(grants[0]!.scopeType).toBe('department');
      expect(grants[0]!.scopeId).toBe(DEPARTMENT);
    });

    it('refuses a company-scope grant that carries a scope id', async () => {
      await expect(
        engine.roles.grantRole({
          organizationId: ORG_A,
          userId: ALICE,
          roleId: ADMIN_ROLE.id,
          scopeType: 'company',
          scopeId: DEPARTMENT,
          grantedBy: ADMIN,
        }),
      ).rejects.toThrow(/company-scope role grant must not specify a scopeId/);
    });

    it('refuses a department-scope grant with no scope id', async () => {
      await expect(
        engine.roles.grantRole({
          organizationId: ORG_A,
          userId: ALICE,
          roleId: SCIENTIST_ROLE.id,
          scopeType: 'department',
          scopeId: null,
          grantedBy: ADMIN,
        }),
      ).rejects.toThrow(/department-scope role grant requires a scopeId/);
    });
  });

  describe('findActiveGrant', () => {
    beforeEach(async () => {
      await engine.createRole(ADMIN_ROLE);
      await engine.createRole(SCIENTIST_ROLE);
    });

    it('matches a company-scope grant whose scope id is null', async () => {
      const grantId = await engine.roles.grantRole({
        organizationId: ORG_A,
        userId: ALICE,
        roleId: ADMIN_ROLE.id,
        scopeType: 'company',
        scopeId: null,
        grantedBy: ADMIN,
      });

      expect(await engine.roles.findActiveGrant(ALICE, ADMIN_ROLE.id, 'company', null)).toBe(
        grantId,
      );
      // A different scope must not match it.
      expect(
        await engine.roles.findActiveGrant(ALICE, ADMIN_ROLE.id, 'department', DEPARTMENT),
      ).toBeNull();
    });

    it('matches a department-scope grant only at its own scope id', async () => {
      const grantId = await engine.roles.grantRole({
        organizationId: ORG_A,
        userId: ALICE,
        roleId: SCIENTIST_ROLE.id,
        scopeType: 'department',
        scopeId: DEPARTMENT,
        grantedBy: ADMIN,
      });

      expect(
        await engine.roles.findActiveGrant(ALICE, SCIENTIST_ROLE.id, 'department', DEPARTMENT),
      ).toBe(grantId);
      expect(
        await engine.roles.findActiveGrant(
          ALICE,
          SCIENTIST_ROLE.id,
          'department',
          '507f1f77bcf86cd799439042',
        ),
      ).toBeNull();
    });

    /**
     * Mongo previously threw here — `new Types.ObjectId('not-an-id')` — where D1 matches
     * nothing. This function answers "is this already granted?", so an exception on the way
     * to "no" turns a duplicate-grant check into a 500.
     */
    it('returns null for an unparseable scope id rather than throwing', async () => {
      expect(
        await engine.roles.findActiveGrant(ALICE, SCIENTIST_ROLE.id, 'department', 'not-an-id'),
      ).toBeNull();
    });

    it('stops matching once the grant is revoked', async () => {
      const grantId = await engine.roles.grantRole({
        organizationId: ORG_A,
        userId: ALICE,
        roleId: ADMIN_ROLE.id,
        scopeType: 'company',
        scopeId: null,
        grantedBy: ADMIN,
      });

      await engine.roles.revokeGrant(grantId, ADMIN);
      expect(await engine.roles.findActiveGrant(ALICE, ADMIN_ROLE.id, 'company', null)).toBeNull();
    });
  });

  /**
   * `role.model.ts` includes `softDeleteFields` but never calls `applySoftDeleteFilter`, so a
   * soft-deleted role is still returned and still confers its permissions in MongoDB. Asserted
   * in both engines because the point is that D1 does not quietly become stricter.
   */
  it('a soft-deleted role still confers its permissions, in both databases', async () => {
    await engine.createRole(ADMIN_ROLE);
    await engine.roles.grantRole({
      organizationId: ORG_A,
      userId: ALICE,
      roleId: ADMIN_ROLE.id,
      scopeType: 'company',
      scopeId: null,
      grantedBy: ADMIN,
    });

    if (engine.name === 'mongo') {
      const { RoleModel } = await import('@/server/db/models');
      const { Types } = await import('mongoose');
      await RoleModel.updateOne(
        { _id: new Types.ObjectId(ADMIN_ROLE.id) },
        { $set: { deletedAt: new Date() } },
      ).exec();
    } else {
      await d1
        .prepare('UPDATE roles SET deleted_at = ? WHERE id = ?')
        .bind(ISO, ADMIN_ROLE.id)
        .run();
    }

    expect(await engine.roles.getActorGrants(ALICE)).toHaveLength(1);
    expect((await engine.roles.listRoles(ORG_A)).map((role) => role.key)).toEqual([
      'administrator',
    ]);
  });
});

/* ================================================================== parity */

describe('parity — the two implementations produce identical results', () => {
  beforeEach(async () => {
    await clearCollections();
    await clearD1(d1, D1_RESET);
    await seedD1World();
  });

  async function seedBoth(): Promise<void> {
    for (const role of [ADMIN_ROLE, SCIENTIST_ROLE, VIEWER_ROLE]) {
      await createMongoRole(role);
      await createD1Role(role);
    }
  }

  it('role records match field for field', async () => {
    await seedBoth();

    const fromMongo = await mongoRoleRepository.listRoles(ORG_A);
    const fromD1 = await d1RoleRepository.listRoles(ORG_A);

    expect(fromD1.map(sortedRole)).toEqual(fromMongo.map(sortedRole));
  });

  it('getActorGrants produces identical grants for an identical world', async () => {
    await seedBoth();

    const grants = [
      {
        roleId: ADMIN_ROLE.id,
        scopeType: 'company' as const,
        scopeId: null,
      },
      {
        roleId: SCIENTIST_ROLE.id,
        scopeType: 'department' as const,
        scopeId: DEPARTMENT,
      },
    ];

    for (const grant of grants) {
      const input = { organizationId: ORG_A, userId: ALICE, grantedBy: ADMIN, ...grant };
      await mongoRoleRepository.grantRole(input);
      await d1RoleRepository.grantRole(input);
    }

    const byRole = (list: RoleGrant[]) =>
      [...list].sort((a, b) => a.roleId.localeCompare(b.roleId)).map(comparableGrant);

    expect(byRole(await d1RoleRepository.getActorGrants(ALICE))).toEqual(
      byRole(await mongoRoleRepository.getActorGrants(ALICE)),
    );
  });

  it('listGrantsForUser matches, including the expired grant both keep', async () => {
    await seedBoth();

    const expired = {
      organizationId: ORG_A,
      userId: ALICE,
      roleId: VIEWER_ROLE.id,
      scopeType: 'project' as const,
      scopeId: DEPARTMENT,
      grantedBy: ADMIN,
      expiresAt: new Date(Date.now() - 60_000),
    };
    await mongoRoleRepository.grantRole(expired);
    await d1RoleRepository.grantRole(expired);

    const fromMongo = (await mongoRoleRepository.listGrantsForUser(ALICE)).map(comparableSummary);
    const fromD1 = (await d1RoleRepository.listGrantsForUser(ALICE)).map(comparableSummary);

    expect(fromD1).toEqual(fromMongo);
    expect(fromD1).toHaveLength(1);
  });

  it('both refuse the same malformed grants', async () => {
    await seedBoth();

    const malformed = {
      organizationId: ORG_A,
      userId: ALICE,
      roleId: ADMIN_ROLE.id,
      scopeType: 'company' as const,
      scopeId: DEPARTMENT,
      grantedBy: ADMIN,
    };

    await expect(mongoRoleRepository.grantRole(malformed)).rejects.toThrow();
    await expect(d1RoleRepository.grantRole(malformed)).rejects.toThrow();
  });
});

/* ================================================================== d1 specifics */

describe('d1 specifics', () => {
  beforeEach(async () => {
    await clearD1(d1, D1_RESET);
    await seedD1World();
    await createD1Role(ADMIN_ROLE);
    await createD1Role(SCIENTIST_ROLE);
  });

  const companyGrant = {
    organizationId: ORG_A,
    userId: ALICE,
    roleId: ADMIN_ROLE.id,
    scopeType: 'company' as const,
    scopeId: null,
    grantedBy: ADMIN,
  };

  /**
   * The divergence migration 0002 exists to close.
   *
   * MongoDB's unique index treats two NULLs as equal and rejects the second grant. SQL treats
   * them as distinct, so migration 0000's index permitted duplicate **company-scope** grants —
   * the most privileged kind. Two active duplicates mean an administrator revokes an admin
   * role, watches it disappear, and the account keeps it through the copy.
   */
  it('refuses a duplicate active company-scope grant (migration 0002)', async () => {
    await d1RoleRepository.grantRole(companyGrant);
    await expect(d1RoleRepository.grantRole(companyGrant)).rejects.toThrow();

    const rows = await d1
      .prepare('SELECT COUNT(*) AS c FROM user_roles WHERE revoked_at IS NULL')
      .first<{ c: number }>();
    expect(rows!.c).toBe(1);
  });

  it('refuses a duplicate active department-scope grant', async () => {
    const grant = {
      organizationId: ORG_A,
      userId: ALICE,
      roleId: SCIENTIST_ROLE.id,
      scopeType: 'department' as const,
      scopeId: DEPARTMENT,
      grantedBy: ADMIN,
    };
    await d1RoleRepository.grantRole(grant);
    await expect(d1RoleRepository.grantRole(grant)).rejects.toThrow();
  });

  /**
   * The index has to stay *partial*. Grants are revoked rather than deleted so the history
   * survives in the audit trail, and a non-partial unique index would make a role ungrantable
   * ever again once revoked.
   */
  it('allows re-granting after revocation, proving the index is still partial', async () => {
    const first = await d1RoleRepository.grantRole(companyGrant);
    await d1RoleRepository.revokeGrant(first, ADMIN);

    const second = await d1RoleRepository.grantRole(companyGrant);
    expect(second).not.toBe(first);

    expect(await d1RoleRepository.getActorGrants(ALICE)).toHaveLength(1);
    const total = await d1
      .prepare('SELECT COUNT(*) AS c FROM user_roles')
      .first<{ c: number }>();
    expect(total!.c).toBe(2);
  });

  /** The catalogue foreign key: a typo'd permission fails at insert instead of granting nothing. */
  it('refuses a role permission that is not in the seeded catalogue', async () => {
    await expect(
      d1
        .prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)')
        .bind(ADMIN_ROLE.id, 'file.vieww')
        .run(),
    ).rejects.toThrow();
  });

  it('reads grants for a user with no roles as an empty list, not an error', async () => {
    expect(await d1RoleRepository.getActorGrants(BOB)).toEqual([]);
    expect(await d1RoleRepository.listGrantsForUser(BOB)).toEqual([]);
    expect(await d1RoleRepository.getActorGrants('')).toEqual([]);
  });
});

/* ================================================================== the flag */

describe('the DATA_SOURCE_ROLES flag', () => {
  beforeEach(async () => {
    await clearCollections();
    await clearD1(d1, D1_RESET);
    await seedD1World();
    clearDataSourceOverrides();
  });

  afterAll(() => clearDataSourceOverrides());

  it('defaults to MongoDB', async () => {
    await createMongoRole(ADMIN_ROLE);
    expect((await roleFacade.findRoleById(ADMIN_ROLE.id))?.name).toBe('Administrator');
  });

  it('routes to D1 when switched, and back when it is not', async () => {
    await createMongoRole({ ...ADMIN_ROLE, name: 'Administrator (Mongo)' });
    await createD1Role({ ...ADMIN_ROLE, name: 'Administrator (D1)' });

    setDataSourceOverride('roles', 'd1');
    expect((await roleFacade.findRoleById(ADMIN_ROLE.id))?.name).toBe('Administrator (D1)');

    setDataSourceOverride('roles', 'mongo');
    expect((await roleFacade.findRoleById(ADMIN_ROLE.id))?.name).toBe('Administrator (Mongo)');
  });

  it('moves roles without moving users or departments', async () => {
    setDataSourceOverride('roles', 'd1');
    const { dataSourceFor } = await import('@/server/repositories/data-source');
    expect(dataSourceFor('roles')).toBe('d1');
    expect(dataSourceFor('users')).toBe('mongo');
    expect(dataSourceFor('departments')).toBe('mongo');
  });
});
