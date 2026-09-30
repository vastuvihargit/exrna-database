/**
 * The fresh-D1 bootstrap (`scripts/bootstrap-d1.ts`), against the real migrated schema.
 *
 * What it proves: the statements apply cleanly to an empty database; running them again — with
 * fresh UUIDs, as a second invocation of the script would — changes nothing and duplicates
 * nothing; an existing row is never modified; and the result is enough for the administrator to
 * sign in through `completeOAuthLogin` in `google_oauth` mode while an unknown Workspace address
 * is still refused and not created.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';

import { clearD1, startTestD1, stopTestD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import {
  DATA_SOURCE_MODULES,
  clearDataSourceOverrides,
  setDataSourceOverride,
} from '@/server/repositories/data-source';
import { BindingGateway } from '@/server/migration/d1/gateway';
import {
  bootstrapProblems,
  planBootstrap,
  readBootstrapState,
  type BootstrapInput,
} from '@/server/migration/d1/bootstrap';
import { DEFAULT_ROLES } from '@/server/domain/roles';

const INPUT: BootstrapInput = {
  adminEmail: 'Admin@exrna.com',
  adminName: 'Staging Admin',
  organizationName: 'Exrna Research',
  organizationSlug: 'exrna',
  emailDomains: ['exrna.com'],
  defaultUserQuotaBytes: 20 * 1024 ** 3,
  defaultDepartmentQuotaBytes: 500 * 1024 ** 3,
  maxUploadBytes: 2048 * 1024 ** 2,
  trashRetentionDays: 30,
};
const LOOKUP = { organizationSlug: 'exrna', adminEmail: 'admin@exrna.com' };
const META = { requestId: 'test', ip: '203.0.113.9', userAgent: 'vitest' };

const ENV_OVERRIDES: Record<string, string> = {
  AUTH_PROVIDER: 'google_oauth',
  APP_URL: 'https://staging.exrna.test',
  GOOGLE_OAUTH_CLIENT_ID: 'staging-client.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'staging-client-secret',
  GOOGLE_WORKSPACE_DOMAIN: 'exrna.com',
  COMPANY_EMAIL_DOMAINS: 'exrna.com',
  // Deliberately on: google_oauth must refuse unknown users even when this says otherwise.
  ALLOW_AUTO_PROVISIONING: 'true',
};
const savedEnv: Record<string, string | undefined> = {};

let d1: D1Database;
let gateway: BindingGateway;

const TABLES = [
  'audit_logs',
  'login_history',
  'sessions',
  'user_auth_providers',
  'user_roles',
  'role_scope_types',
  'role_permissions',
  'roles',
  'users',
  'organizations',
];

async function tableCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const row = await d1.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
    counts[table] = row?.n ?? 0;
  }
  return counts;
}

async function resetEnv(): Promise<void> {
  const { resetEnvCache } = await import('@/server/config/env');
  resetEnvCache();
}

beforeAll(async () => {
  for (const [name, value] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
  for (const name of DATA_SOURCE_MODULES) setDataSourceOverride(name, 'd1');
  d1 = await startTestD1();
  setD1BindingForTesting(d1);
  gateway = new BindingGateway(d1, 'test');
  await resetEnv();
}, 300_000);

afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearDataSourceOverrides();
  setD1BindingForTesting(null);
  await resetEnv();
  await stopTestD1();
});

beforeEach(async () => {
  // The immutability trigger refuses DELETE, so audit_logs is emptied the one way it allows
  // (as in audit-log-repository.test.ts), and the trigger is put back exactly as 0001 wrote it.
  await d1.prepare('DROP TRIGGER IF EXISTS trg_audit_logs_no_delete').run();
  await clearD1(d1, TABLES.map((table) => `DELETE FROM ${table}`));
  await d1
    .prepare(
      `CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
       BEFORE DELETE ON audit_logs
       BEGIN SELECT RAISE(ABORT, 'Audit logs are append-only and cannot be modified or deleted'); END;`,
    )
    .run();
  const { resetAllRateLimits } = await import('@/server/auth/rate-limit');
  resetAllRateLimits();
});

describe('planBootstrap', () => {
  it('refuses an administrator outside the organization domains', () => {
    expect(() => planBootstrap({ ...INPUT, adminEmail: 'someone@gmail.com' })).toThrow(/domains/);
  });

  it('never stores auto-provisioning as on', () => {
    const [organization] = planBootstrap(INPUT).statements;
    const settings = JSON.parse(String(organization!.params[4]));
    expect(settings.allowAutoProvisioning).toBe(false);
  });
});

describe('on an empty database', () => {
  it('creates exactly the first-login records', async () => {
    await gateway.run(planBootstrap(INPUT).statements);

    const state = await readBootstrapState(gateway, LOOKUP);
    expect(bootstrapProblems(state)).toEqual([]);
    expect(state.organizations).toBe(1);
    expect(state.roles).toBe(DEFAULT_ROLES.length);
    expect(state.users).toBe(1);
    expect(state.admin).toMatchObject({
      status: 'active',
      isSuperAdmin: true,
      organizationMatches: true,
      activeSuperAdminGrants: 1,
    });

    const counts = await tableCounts();
    // No login yet: no session, provider link, history or audit row.
    expect(counts).toMatchObject({ sessions: 0, user_auth_providers: 0, login_history: 0, audit_logs: 0 });

    // The role catalogue matches the code, permission for permission.
    for (const role of DEFAULT_ROLES) {
      const row = await d1
        .prepare(
          'SELECT count(*) AS n FROM role_permissions p JOIN roles r ON r.id = p.role_id WHERE r.key = ?',
        )
        .bind(role.key)
        .first<{ n: number }>();
      expect(row?.n, role.key).toBe(new Set(role.permissions).size);
    }
  });

  it('is idempotent: re-runs with fresh ids change and duplicate nothing', async () => {
    await gateway.run(planBootstrap(INPUT).statements);
    const first = await tableCounts();
    const ids = await d1.prepare('SELECT id FROM organizations UNION ALL SELECT id FROM users').all();

    await gateway.run(planBootstrap(INPUT).statements);
    await gateway.run(planBootstrap(INPUT).statements);

    expect(await tableCounts()).toEqual(first);
    expect((await d1.prepare('SELECT id FROM organizations UNION ALL SELECT id FROM users').all()).results).toEqual(
      ids.results,
    );
    expect(bootstrapProblems(await readBootstrapState(gateway, LOOKUP))).toEqual([]);
  });
});

describe('on a database that already has the rows', () => {
  it('never reactivates, promotes or re-grants an administrator changed by hand', async () => {
    await gateway.run(planBootstrap(INPUT).statements);
    await d1.prepare("UPDATE users SET status = 'deactivated', is_super_admin = 0 WHERE email = ?").bind(LOOKUP.adminEmail).run();
    await d1.prepare("UPDATE user_roles SET revoked_at = '2026-09-30T00:00:00.000Z'").run();
    await d1.prepare("UPDATE organizations SET name = 'Renamed'").run();

    await gateway.run(planBootstrap(INPUT).statements);

    const state = await readBootstrapState(gateway, LOOKUP);
    expect(state.admin).toMatchObject({
      status: 'deactivated',
      isSuperAdmin: false,
      activeSuperAdminGrants: 0,
    });
    expect((await d1.prepare('SELECT count(*) AS n FROM user_roles').first<{ n: number }>())?.n).toBe(1);
    expect((await d1.prepare('SELECT name FROM organizations').first<{ name: string }>())?.name).toBe('Renamed');
    // Reported, not "fixed": undoing a deactivation or a revocation is a person's decision.
    expect(bootstrapProblems(state)).toEqual([
      'the administrator\'s status is "deactivated", not "active"',
      'the administrator is not flagged is_super_admin',
      'expected 1 active company-scope super_admin grant, found 0',
    ]);
  });
});

describe('first sign-in with google_oauth', () => {
  it('signs the bootstrapped administrator in as a Super Admin', async () => {
    await gateway.run(planBootstrap(INPUT).statements);
    const { completeOAuthLogin } = await import('@/server/services/auth.service');

    const session = await completeOAuthLogin(
      { email: 'admin@exrna.com', providerAccountId: 'google-sub-1', provider: 'google' },
      META,
    );

    const { resolveRequestSession } = await import('@/server/auth/access-session');
    const resolved = await resolveRequestSession(session.token, new Headers());
    expect(resolved?.actor.userId).toBe((await readBootstrapState(gateway, LOOKUP)).admin?.id);
    expect(resolved?.actor.isSuperAdmin).toBe(true);
    expect(resolved?.actor.roleKeys).toEqual(['super_admin']);

    // The first sign-in links the Google account; nothing else about the user changes.
    const link = await d1.prepare('SELECT provider, provider_account_id FROM user_auth_providers').all();
    expect(link.results).toEqual([{ provider: 'google', provider_account_id: 'google-sub-1' }]);
  });

  it('still refuses an unknown Workspace user, and does not create one', async () => {
    await gateway.run(planBootstrap(INPUT).statements);
    const { completeOAuthLogin } = await import('@/server/services/auth.service');

    await expect(
      completeOAuthLogin(
        { email: 'stranger@exrna.com', providerAccountId: 'google-sub-2', provider: 'google' },
        META,
      ),
    ).rejects.toThrow(/not been set up/);

    const counts = await tableCounts();
    expect(counts.users).toBe(1);
    expect(counts.sessions).toBe(0);
  });
});
