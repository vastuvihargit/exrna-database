/**
 * Migration 0003 — the role-grant scope invariant, enforced by the database.
 *
 * The point of this suite is that it goes **around** the repository. `assertScopeShape()`
 * already stops the application writing a malformed grant, and module 2 proves that. What was
 * missing, and what 0003 adds, is enforcement for every other writer: a seed script, a fixture,
 * the Phase 5 migration, or somebody typing SQL during an incident. So every negative case here
 * is a raw `INSERT`/`UPDATE`, not a repository call.
 *
 * It also checks the rebuild did not quietly lose anything: the table is recreated from
 * scratch by 0003, and a rebuild that dropped a foreign key or an index would still let every
 * scope test pass.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import { d1RoleRepository } from '@/server/repositories/role.repository';
import { SCOPE_TYPES } from '@/server/domain/permissions';

const ORG = '507f1f77bcf86cd799439011';
const ALICE = '507f1f77bcf86cd799439031';
const ADMIN = '507f1f77bcf86cd799439033';
const ROLE = '507f1f77bcf86cd799439051';
const TARGET = '507f1f77bcf86cd799439041';
const ISO = '2026-01-01T00:00:00.000Z';

let d1: D1Database;

async function seed(): Promise<void> {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO organizations
         (id, name, slug, email_domains, settings, storage_used_bytes, file_count, is_active, created_at, updated_at)
       VALUES (?, 'Org', 'org', '[]', '{}', 0, 0, 1, ?, ?)`,
    )
    .bind(ORG, ISO, ISO)
    .run();

  for (const [id, email] of [
    [ALICE, 'alice@company.com'],
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
      .bind(id, ORG, email, email.split('@')[0], ISO, ISO)
      .run();
  }

  await d1
    .prepare(
      `INSERT OR IGNORE INTO roles
         (id, organization_id, key, name, description, rank, max_confidentiality,
          company_wide_read, is_system, created_at, updated_at)
       VALUES (?, ?, 'administrator', 'Administrator', '', 90, 'internal', 0, 0, ?, ?)`,
    )
    .bind(ROLE, ORG, ISO, ISO)
    .run();
}

/** A raw insert, deliberately bypassing the repository. */
function rawInsert(
  id: string,
  scopeType: string,
  scopeId: string | null,
): Promise<unknown> {
  return d1
    .prepare(
      `INSERT INTO user_roles
         (id, organization_id, user_id, role_id, scope_type, scope_id, granted_by,
          granted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, ORG, ALICE, ROLE, scopeType, scopeId, ADMIN, ISO, ISO, ISO)
    .run();
}

beforeAll(async () => {
  d1 = await startTestD1();
  setD1BindingForTesting(d1);
  await seed();
}, 300_000);

afterAll(async () => {
  setD1BindingForTesting(null);
  await stopTestD1();
});

beforeEach(async () => {
  await clearD1(d1, ['DELETE FROM user_roles']);
});

/* ------------------------------------------------------------------ the rebuild */

describe('the table rebuild', () => {
  it('leaves exactly one user_roles table and no leftover scratch table', async () => {
    const rows = await d1
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'user_roles%' ORDER BY name`,
      )
      .all<{ name: string }>();
    expect(rows.results.map((row) => row.name)).toEqual(['user_roles']);
  });

  it('carries both CHECK constraints into the rebuilt table definition', async () => {
    const row = await d1
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='user_roles'`)
      .first<{ sql: string }>();

    expect(row!.sql).toContain('ck_user_roles_scope_type');
    expect(row!.sql).toContain('ck_user_roles_scope_shape');
  });

  /**
   * A rebuild that dropped a foreign key would pass every scope test in this file while
   * quietly removing referential integrity from the permission table.
   */
  it('keeps all five foreign keys', async () => {
    const rows = await d1.prepare(`PRAGMA foreign_key_list('user_roles')`).all<{ table: string }>();
    expect(rows.results).toHaveLength(5);
    expect([...new Set(rows.results.map((row) => row.table))].sort()).toEqual([
      'organizations',
      'roles',
      'users',
    ]);
  });

  it('enforces those foreign keys after the rebuild', async () => {
    await expect(
      d1
        .prepare(
          `INSERT INTO user_roles
             (id, organization_id, user_id, role_id, scope_type, scope_id, granted_at, created_at, updated_at)
           VALUES ('fk-1', ?, 'no-such-user', ?, 'company', NULL, ?, ?, ?)`,
        )
        .bind(ORG, ROLE, ISO, ISO, ISO)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('recreates all four indexes, with ux_user_roles_active still the 0002 expression form', async () => {
    const rows = await d1
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type='index' AND tbl_name='user_roles' AND sql IS NOT NULL ORDER BY name`,
      )
      .all<{ name: string; sql: string }>();

    expect(rows.results.map((row) => row.name)).toEqual([
      'ix_user_roles_expiry',
      'ix_user_roles_scope',
      'ix_user_roles_user',
      'ux_user_roles_active',
    ]);

    const unique = rows.results.find((row) => row.name === 'ux_user_roles_active')!;
    // Both halves matter: the coalesce is migration 0002, the WHERE keeps it partial so a
    // revoked grant can be re-granted.
    expect(unique.sql.toLowerCase()).toContain('coalesce');
    expect(unique.sql.toLowerCase()).toContain('revoked_at is null');
  });
});

/* ------------------------------------------------------------------ positive cases */

describe('valid scope combinations are accepted', () => {
  it('accepts company scope with no scope id', async () => {
    await expect(rawInsert('ok-company', 'company', null)).resolves.toBeDefined();
  });

  it.each(SCOPE_TYPES.filter((scope) => scope !== 'company'))(
    'accepts %s scope with a scope id',
    async (scopeType) => {
      await expect(rawInsert(`ok-${scopeType}`, scopeType, TARGET)).resolves.toBeDefined();
    },
  );

  it('accepts every valid combination in one batch, proving the copy step would too', async () => {
    for (const scopeType of SCOPE_TYPES) {
      const scopeId = scopeType === 'company' ? null : `${TARGET}-${scopeType}`;
      await rawInsert(`batch-${scopeType}`, scopeType, scopeId);
    }
    const count = await d1
      .prepare('SELECT COUNT(*) AS c FROM user_roles')
      .first<{ c: number }>();
    expect(count!.c).toBe(SCOPE_TYPES.length);
  });
});

/* ------------------------------------------------------------------ negative cases */

describe('malformed grants cannot be inserted through raw SQL', () => {
  it('refuses a company-scope grant that carries a scope id', async () => {
    await expect(rawInsert('bad-1', 'company', TARGET)).rejects.toThrow(
      /CHECK constraint failed|ck_user_roles_scope_shape/i,
    );
  });

  it.each(SCOPE_TYPES.filter((scope) => scope !== 'company'))(
    'refuses a %s-scope grant with a null scope id',
    async (scopeType) => {
      await expect(rawInsert(`bad-null-${scopeType}`, scopeType, null)).rejects.toThrow(
        /CHECK constraint failed|ck_user_roles_scope_shape/i,
      );
    },
  );

  /**
   * Migration 0002 maps NULL onto '' inside `ux_user_roles_active`, so an empty-string
   * scope_id would be indistinguishable from a company-scope grant in that index — one would
   * silently block the other.
   */
  it('refuses an empty-string scope id, which 0002 uses as the company-scope sentinel', async () => {
    await expect(rawInsert('bad-empty', 'department', '')).rejects.toThrow(
      /CHECK constraint failed|ck_user_roles_scope_shape/i,
    );
  });

  it('refuses a scope type outside the five valid values', async () => {
    await expect(rawInsert('bad-type', 'organisation', TARGET)).rejects.toThrow(
      /CHECK constraint failed|ck_user_roles_scope_type/i,
    );
  });

  it('refuses an empty scope type', async () => {
    await expect(rawInsert('bad-blank-type', '', TARGET)).rejects.toThrow(
      /CHECK constraint failed/i,
    );
  });

  it('leaves no row behind when a malformed insert is refused', async () => {
    await expect(rawInsert('bad-2', 'company', TARGET)).rejects.toThrow();
    const count = await d1
      .prepare('SELECT COUNT(*) AS c FROM user_roles')
      .first<{ c: number }>();
    expect(count!.c).toBe(0);
  });
});

/* ------------------------------------------------------------------ updates */

describe('the invariant also holds on UPDATE, not only INSERT', () => {
  it('refuses to add a scope id to an existing company-scope grant', async () => {
    await rawInsert('upd-1', 'company', null);

    await expect(
      d1.prepare(`UPDATE user_roles SET scope_id = ? WHERE id = 'upd-1'`).bind(TARGET).run(),
    ).rejects.toThrow(/CHECK constraint failed/i);

    const row = await d1
      .prepare(`SELECT scope_id FROM user_roles WHERE id = 'upd-1'`)
      .first<{ scope_id: string | null }>();
    expect(row!.scope_id).toBeNull();
  });

  it('refuses to clear the scope id of a department-scope grant', async () => {
    await rawInsert('upd-2', 'department', TARGET);
    await expect(
      d1.prepare(`UPDATE user_roles SET scope_id = NULL WHERE id = 'upd-2'`).run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('refuses to change the scope type in a way that invalidates the pair', async () => {
    await rawInsert('upd-3', 'department', TARGET);
    // department -> company while keeping the scope id.
    await expect(
      d1.prepare(`UPDATE user_roles SET scope_type = 'company' WHERE id = 'upd-3'`).run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('allows a legitimate scope change that keeps the pair valid', async () => {
    await rawInsert('upd-4', 'department', TARGET);
    await expect(
      d1.prepare(`UPDATE user_roles SET scope_type = 'project' WHERE id = 'upd-4'`).run(),
    ).resolves.toBeDefined();
  });

  /** Revocation must keep working — it is the normal write path for this table. */
  it('allows revocation, which touches neither scope column', async () => {
    await rawInsert('upd-5', 'company', null);
    await expect(
      d1
        .prepare(`UPDATE user_roles SET revoked_at = ?, revoked_by = ? WHERE id = 'upd-5'`)
        .bind(ISO, ADMIN)
        .run(),
    ).resolves.toBeDefined();
  });
});

/* ------------------------------------------------------------------ defence in depth */

describe('repository validation still runs in front of the constraint', () => {
  it('rejects at the application layer with a readable message, not a constraint failure', async () => {
    // `assertScopeShape` should catch this before SQL ever sees it, so the error names the
    // rule rather than the constraint.
    await expect(
      d1RoleRepository.grantRole({
        organizationId: ORG,
        userId: ALICE,
        roleId: ROLE,
        scopeType: 'company',
        scopeId: TARGET,
        grantedBy: ADMIN,
      }),
    ).rejects.toThrow(/company-scope role grant must not specify a scopeId/);
  });

  it('still writes valid grants through the repository after the rebuild', async () => {
    const id = await d1RoleRepository.grantRole({
      organizationId: ORG,
      userId: ALICE,
      roleId: ROLE,
      scopeType: 'department',
      scopeId: TARGET,
      grantedBy: ADMIN,
    });

    expect(await d1RoleRepository.findActiveGrant(ALICE, ROLE, 'department', TARGET)).toBe(id);
    expect(await d1RoleRepository.getActorGrants(ALICE)).toHaveLength(1);
  });

  it('still refuses a duplicate active company-scope grant (migration 0002 survived)', async () => {
    const grant = {
      organizationId: ORG,
      userId: ALICE,
      roleId: ROLE,
      scopeType: 'company' as const,
      scopeId: null,
      grantedBy: ADMIN,
    };
    await d1RoleRepository.grantRole(grant);
    await expect(d1RoleRepository.grantRole(grant)).rejects.toThrow();
  });
});
