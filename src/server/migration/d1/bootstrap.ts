/**
 * First-login bootstrap for a D1 database that starts empty — no MongoDB, no migration.
 *
 * Writes the least a deployment needs before anyone can sign in: the organization, the system
 * role catalogue (`DEFAULT_ROLES`), one active Super Admin and that user's company-scope
 * `super_admin` grant. Everything else — departments, drives, other users — is created in the
 * application by that administrator.
 *
 * ── Idempotent in the SQL, not just in the caller ───────────────────────────────────────
 *
 * Every insert is keyed on a natural key the schema already declares unique, and resolves its
 * foreign keys by that key rather than by an id computed in this process:
 *
 *   organizations   ON CONFLICT (slug)                   ux_organizations_slug
 *   roles           ON CONFLICT (organization_id, key)   ux_roles_org_key
 *   role children   ON CONFLICT DO NOTHING               ux_role_permissions, ux_role_scope_types
 *   users           ON CONFLICT (email)                  ux_users_email
 *   user_roles      WHERE NOT EXISTS (any such grant)    ux_user_roles_active (migration 0002)
 *
 * So a second run — or two runs racing — converges on the same rows. The fresh UUIDs in the
 * statements are only used by the insert that wins; a losing insert is a no-op, and the rows
 * after it look the winner up by slug, key and email.
 *
 * ── Create, never modify ────────────────────────────────────────────────────────────────
 *
 * Every conflict is `DO NOTHING`. A re-run never renames the organization, never resets a role
 * an administrator has edited, and never reactivates or promotes a user somebody deactivated or
 * demoted on purpose. If the named administrator already exists but is not an active Super
 * Admin, `verifyBootstrap` reports it instead of "fixing" it: that is a decision for a person.
 *
 * ── What it deliberately does not do ────────────────────────────────────────────────────
 *
 * It never writes `allowAutoProvisioning: true`, never creates a password, and never links a
 * Google account — the first real sign-in does that (`completeOAuthLogin` →
 * `linkAuthProvider`). With `AUTH_PROVIDER=google_oauth` auto-provisioning is off regardless of
 * the stored setting, so an unknown Workspace user is still refused.
 */
import { normalizeCompanyEmail } from '@/server/auth/email-domain';
import { PERMISSIONS, SCOPE_TYPES } from '@/server/domain/permissions';
import { DEFAULT_ROLES } from '@/server/domain/roles';
import type { D1Gateway, Statement } from './types';

export interface BootstrapInput {
  adminEmail: string;
  adminName?: string;
  organizationName: string;
  organizationSlug: string;
  /** The organization's sign-in allow-list. The administrator's domain must be on it. */
  emailDomains: string[];
  defaultUserQuotaBytes: number;
  defaultDepartmentQuotaBytes: number;
  maxUploadBytes: number;
  trashRetentionDays: number;
}

export interface BootstrapPlan {
  adminEmail: string;
  statements: Statement[];
}

const SUPER_ADMIN_ROLE = 'super_admin';

/** Resolves the organization id by slug inside the statement, so no id crosses statements. */
const ORG_BY_SLUG = '(SELECT id FROM organizations WHERE slug = ?)';

/**
 * The statements, in dependency order. Pure: reads nothing, so it can be rendered for review
 * before anything touches a database.
 */
export function planBootstrap(input: BootstrapInput, now = new Date().toISOString()): BootstrapPlan {
  const emailDomains = [...new Set(input.emailDomains.map((domain) => domain.trim().toLowerCase()))];
  if (emailDomains.length === 0) throw new Error('At least one organization email domain is required');

  const adminEmail = normalizeCompanyEmail(input.adminEmail, emailDomains);
  if (!adminEmail) {
    throw new Error(
      `The administrator's address must be on the organization's domains (${emailDomains.join(', ')})`,
    );
  }
  const slug = input.organizationSlug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`"${slug}" is not a valid organization slug`);

  const statements: Statement[] = [];

  statements.push({
    sql:
      'INSERT INTO organizations (id, name, slug, email_domains, settings, storage_used_bytes, ' +
      'file_count, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 1, ?, ?) ' +
      'ON CONFLICT (slug) DO NOTHING',
    params: [
      crypto.randomUUID(),
      input.organizationName.trim(),
      slug,
      JSON.stringify(emailDomains),
      JSON.stringify({
        // Written out as false rather than omitted, so the stored intent is visible to anyone
        // reading the row. `google_oauth` ignores it anyway (`completeOAuthLogin`).
        allowAutoProvisioning: false,
        defaultUserQuotaBytes: input.defaultUserQuotaBytes,
        defaultDepartmentQuotaBytes: input.defaultDepartmentQuotaBytes,
        maxUploadBytes: input.maxUploadBytes,
        trashRetentionDays: input.trashRetentionDays,
      }),
      now,
      now,
    ],
  });

  const roleBySlugAndKey = `(SELECT id FROM roles WHERE organization_id = ${ORG_BY_SLUG} AND key = ?)`;

  for (const role of DEFAULT_ROLES) {
    // `INSERT … SELECT … WHERE true` rather than `VALUES`: SQLite cannot tell an upsert clause
    // from a join constraint after a bare SELECT, and the WHERE settles it.
    statements.push({
      sql:
        'INSERT INTO roles (id, organization_id, key, name, description, rank, max_confidentiality, ' +
        'company_wide_read, is_system, created_by, created_at, updated_at) ' +
        `SELECT ?, ${ORG_BY_SLUG}, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ? WHERE true ` +
        'ON CONFLICT (organization_id, key) DO NOTHING',
      params: [
        crypto.randomUUID(),
        slug,
        role.key,
        role.name,
        role.description,
        role.rank,
        role.maxConfidentiality,
        role.companyWideRead ? 1 : 0,
        now,
        now,
      ],
    });

    // Filtered against the catalogue for the same reason the migration filters: the foreign key
    // into `permissions` would abort the whole batch on a name the seed does not know.
    for (const permission of new Set(role.permissions)) {
      if (!(PERMISSIONS as readonly string[]).includes(permission)) continue;
      statements.push({
        sql:
          `INSERT INTO role_permissions (role_id, permission_key) SELECT ${roleBySlugAndKey}, ? ` +
          'WHERE true ON CONFLICT DO NOTHING',
        params: [slug, role.key, permission],
      });
    }
    for (const scopeType of new Set(role.scopeTypes)) {
      if (!(SCOPE_TYPES as readonly string[]).includes(scopeType)) continue;
      statements.push({
        sql:
          `INSERT INTO role_scope_types (role_id, scope_type) SELECT ${roleBySlugAndKey}, ? ` +
          'WHERE true ON CONFLICT DO NOTHING',
        params: [slug, role.key, scopeType],
      });
    }
  }

  const [localPart, domain] = adminEmail.split('@') as [string, string];
  statements.push({
    sql:
      'INSERT INTO users (id, organization_id, email, email_domain, name, status, is_super_admin, ' +
      'storage_quota_bytes, activated_at, created_at, updated_at) ' +
      `SELECT ?, ${ORG_BY_SLUG}, ?, ?, ?, 'active', 1, ?, ?, ?, ? WHERE true ` +
      'ON CONFLICT (email) DO NOTHING',
    params: [
      crypto.randomUUID(),
      slug,
      adminEmail,
      domain,
      input.adminName?.trim() || localPart,
      input.defaultUserQuotaBytes,
      now,
      now,
      now,
    ],
  });

  // Company scope: `scope_id` NULL, as migration 0003's CHECK requires. The NOT EXISTS covers
  // revoked grants too: a revocation is a decision, and a re-run must not undo it. For active
  // grants `ux_user_roles_active` stays the backstop if two runs race past the check.
  statements.push({
    sql:
      'INSERT INTO user_roles (id, organization_id, user_id, role_id, scope_type, scope_id, ' +
      'granted_by, granted_at, created_at, updated_at) ' +
      "SELECT ?, u.organization_id, u.id, r.id, 'company', NULL, NULL, ?, ?, ? " +
      'FROM users u JOIN roles r ON r.organization_id = u.organization_id AND r.key = ? ' +
      'WHERE u.email = ? AND NOT EXISTS (' +
      'SELECT 1 FROM user_roles g WHERE g.user_id = u.id AND g.role_id = r.id ' +
      "AND g.scope_type = 'company' AND g.scope_id IS NULL)",
    params: [crypto.randomUUID(), now, now, now, SUPER_ADMIN_ROLE, adminEmail],
  });

  return { adminEmail, statements };
}

export interface BootstrapState {
  organizations: number;
  organizationsWithSlug: number;
  roles: number;
  systemRolesPresent: number;
  rolePermissions: number;
  roleScopeTypes: number;
  users: number;
  admin: {
    id: string;
    status: string;
    isSuperAdmin: boolean;
    organizationMatches: boolean;
    activeSuperAdminGrants: number;
  } | null;
  duplicates: {
    organizationSlugs: number;
    userEmails: number;
    roleKeys: number;
    activeGrants: number;
    rolePermissions: number;
    roleScopeTypes: number;
  };
}

/** Read-only. Safe on a `DryRunGateway`, which refuses anything but a SELECT. */
export async function readBootstrapState(
  gateway: D1Gateway,
  input: Pick<BootstrapInput, 'organizationSlug'> & { adminEmail: string },
): Promise<BootstrapState> {
  const slug = input.organizationSlug.trim().toLowerCase();
  const email = input.adminEmail.trim().toLowerCase();
  const keys = DEFAULT_ROLES.map((role) => role.key);

  const [counts] = await gateway.query<Record<string, number>>(
    'SELECT ' +
      '(SELECT count(*) FROM organizations) AS organizations, ' +
      '(SELECT count(*) FROM organizations WHERE slug = ?) AS organizations_with_slug, ' +
      '(SELECT count(*) FROM roles) AS roles, ' +
      `(SELECT count(*) FROM roles WHERE organization_id = ${ORG_BY_SLUG} AND is_system = 1 ` +
      `AND key IN (${keys.map(() => '?').join(', ')})) AS system_roles_present, ` +
      '(SELECT count(*) FROM role_permissions) AS role_permissions, ' +
      '(SELECT count(*) FROM role_scope_types) AS role_scope_types, ' +
      '(SELECT count(*) FROM users) AS users, ' +
      '(SELECT count(*) FROM (SELECT slug FROM organizations GROUP BY slug HAVING count(*) > 1)) AS dup_slugs, ' +
      '(SELECT count(*) FROM (SELECT email FROM users GROUP BY email HAVING count(*) > 1)) AS dup_emails, ' +
      '(SELECT count(*) FROM (SELECT 1 FROM roles GROUP BY organization_id, key HAVING count(*) > 1)) AS dup_roles, ' +
      '(SELECT count(*) FROM (SELECT 1 FROM user_roles WHERE revoked_at IS NULL ' +
      "GROUP BY user_id, role_id, scope_type, coalesce(scope_id, '') HAVING count(*) > 1)) AS dup_grants, " +
      '(SELECT count(*) FROM (SELECT 1 FROM role_permissions GROUP BY role_id, permission_key HAVING count(*) > 1)) AS dup_role_permissions, ' +
      '(SELECT count(*) FROM (SELECT 1 FROM role_scope_types GROUP BY role_id, scope_type HAVING count(*) > 1)) AS dup_role_scope_types',
    [slug, slug, ...keys],
  );

  const [admin] = await gateway.query<{
    id: string;
    status: string;
    is_super_admin: number;
    organization_matches: number;
    active_super_admin_grants: number;
  }>(
    'SELECT u.id, u.status, u.is_super_admin, ' +
      `(u.organization_id = ${ORG_BY_SLUG}) AS organization_matches, ` +
      '(SELECT count(*) FROM user_roles g JOIN roles r ON r.id = g.role_id ' +
      "WHERE g.user_id = u.id AND r.key = ? AND g.scope_type = 'company' AND g.scope_id IS NULL " +
      'AND g.revoked_at IS NULL) AS active_super_admin_grants ' +
      'FROM users u WHERE u.email = ?',
    [slug, SUPER_ADMIN_ROLE, email],
  );

  const n = (key: string) => Number(counts?.[key] ?? 0);
  return {
    organizations: n('organizations'),
    organizationsWithSlug: n('organizations_with_slug'),
    roles: n('roles'),
    systemRolesPresent: n('system_roles_present'),
    rolePermissions: n('role_permissions'),
    roleScopeTypes: n('role_scope_types'),
    users: n('users'),
    admin: admin
      ? {
          id: admin.id,
          status: admin.status,
          isSuperAdmin: Boolean(admin.is_super_admin),
          organizationMatches: Boolean(admin.organization_matches),
          activeSuperAdminGrants: Number(admin.active_super_admin_grants),
        }
      : null,
    duplicates: {
      organizationSlugs: n('dup_slugs'),
      userEmails: n('dup_emails'),
      roleKeys: n('dup_roles'),
      activeGrants: n('dup_grants'),
      rolePermissions: n('dup_role_permissions'),
      roleScopeTypes: n('dup_role_scope_types'),
    },
  };
}

/** Every reason the database is not ready for the administrator's first sign-in. Empty = ready. */
export function bootstrapProblems(state: BootstrapState): string[] {
  const problems: string[] = [];
  if (state.organizationsWithSlug !== 1) problems.push(`expected 1 organization with the slug, found ${state.organizationsWithSlug}`);
  // Single tenant: sign-in reads the allow-list from `getPrimary()`, the oldest active
  // organization. A second one could be that row, with the administrator attached to the other.
  if (state.organizations > 1) problems.push(`expected 1 organization in total, found ${state.organizations}`);
  if (state.systemRolesPresent !== DEFAULT_ROLES.length) {
    problems.push(`expected ${DEFAULT_ROLES.length} system roles, found ${state.systemRolesPresent}`);
  }
  if (!state.admin) {
    problems.push('the administrator does not exist');
  } else {
    if (state.admin.status !== 'active') problems.push(`the administrator's status is "${state.admin.status}", not "active"`);
    if (!state.admin.isSuperAdmin) problems.push('the administrator is not flagged is_super_admin');
    if (!state.admin.organizationMatches) problems.push('the administrator belongs to a different organization');
    if (state.admin.activeSuperAdminGrants !== 1) {
      problems.push(`expected 1 active company-scope super_admin grant, found ${state.admin.activeSuperAdminGrants}`);
    }
  }
  for (const [what, count] of Object.entries(state.duplicates)) {
    if (count > 0) problems.push(`${count} duplicated ${what}`);
  }
  return problems;
}
