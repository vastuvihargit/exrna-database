/**
 * Tenant, employees, departments — and the tables that used to be arrays inside them.
 */
import { index, sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { AUTH_PROVIDERS, USER_STATUSES } from '@/server/db/models/user.model';
import { boolean, enumText, softDeleteColumns, timestampColumns } from './_shared';

/* ------------------------------------------------------------------ organizations */

export const organizations = sqliteTable(
  'organizations',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** Comma-free JSON array. Read whole, never joined — the domain list is a handful long. */
    emailDomains: text('email_domains').notNull().default('[]'),
    /**
     * `organizationSettingsSchema` as JSON.
     *
     * Nine scalar fields plus three string arrays, always read together by
     * `organizationRepository.settings()` and never filtered on. Nine columns would be nine
     * migrations the first time an admin-configurable option is added.
     */
    settings: text('settings').notNull(),
    storageUsedBytes: integer('storage_used_bytes').notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [uniqueIndex('ux_organizations_slug').on(table.slug)],
);

/* ------------------------------------------------------------------ departments */

export const departments = sqliteTable(
  'departments',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    code: text('code').notNull(),
    description: text('description').notNull().default(''),

    headUserId: text('head_user_id').references((): AnySQLiteColumn => users.id),
    /** Self-reference: a department may sit under another. */
    parentDepartmentId: text('parent_department_id').references(
      (): AnySQLiteColumn => departments.id,
    ),
    /**
     * Circular by nature — a department owns a root folder, and that folder names its
     * department. SQLite resolves foreign-key targets at DML time rather than DDL time, so
     * both constraints can be declared at CREATE TABLE. The Phase 5 migration loads
     * departments first with this null and back-fills after folders exist (step 10).
     */
    rootFolderId: text('root_folder_id'),

    storageQuotaBytes: integer('storage_quota_bytes').notNull(),
    storageUsedBytes: integer('storage_used_bytes').notNull().default(0),
    memberCount: integer('member_count').notNull().default(0),

    isActive: boolean('is_active').notNull().default(true),
    createdBy: text('created_by').references((): AnySQLiteColumn => users.id),
    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('ux_departments_org_code').on(table.organizationId, table.code),
    index('ix_departments_org_active').on(table.organizationId, table.isActive, table.deletedAt),
    index('ix_departments_head').on(table.headUserId),
  ],
);

/* ------------------------------------------------------------------ users */

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),

    email: text('email').notNull(),
    emailDomain: text('email_domain').notNull(),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    jobTitle: text('job_title'),
    phone: text('phone'),

    /**
     * Argon2id, migrated unchanged and dormant from Phase 8.
     *
     * Kept rather than dropped at cutover because it *is* the rollback path: until the
     * MongoDB rollback expires, a revert to the Node deployment has to be able to
     * authenticate people. Phase 9 drops the column.
     */
    passwordHash: text('password_hash'),
    passwordUpdatedAt: text('password_updated_at'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    /** `mfa` sub-document as JSON. `secret` and `backupCodes` never leave the server. */
    mfa: text('mfa').notNull().default('{"enabled":false}'),
    preferences: text('preferences').notNull().default('{}'),

    status: enumText('status', USER_STATUSES).notNull().default('invited'),
    isSuperAdmin: boolean('is_super_admin').notNull().default(false),

    departmentId: text('department_id').references(() => departments.id),
    /**
     * `users.projectIds[]` is **not** reproduced.
     *
     * Mongo kept project membership twice — here and on `projects.memberUserIds[]` — and
     * kept them in step from the service layer. Two copies of one fact is two things that
     * can disagree, and the disagreement is invisible until somebody cannot see a project
     * they are a member of. `project_members` is the single source in D1, and the visibility
     * query joins it. See `research.ts`.
     */

    storageQuotaBytes: integer('storage_quota_bytes').notNull(),
    storageUsedBytes: integer('storage_used_bytes').notNull().default(0),

    lastLoginAt: text('last_login_at'),
    lastActiveAt: text('last_active_at'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: text('locked_until'),

    invitedBy: text('invited_by').references((): AnySQLiteColumn => users.id),
    invitedAt: text('invited_at'),
    activatedAt: text('activated_at'),
    deactivatedAt: text('deactivated_at'),
    deactivatedBy: text('deactivated_by').references((): AnySQLiteColumn => users.id),
    deactivationReason: text('deactivation_reason'),

    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('ux_users_email').on(table.email),
    index('ix_users_org_status_dept').on(table.organizationId, table.status, table.departmentId),
    index('ix_users_locked').on(table.lockedUntil),
    // `status` alone: `resolveSession()` re-reads it on every request, and Phase 8 keeps
    // doing so — it is the immediate-deactivation guarantee.
    index('ix_users_status').on(table.status),
  ],
);

/* ------------------------------------------------------------------ user_auth_providers */

/** `users.authProviders[]`. A child table because it is looked up by provider account id. */
export const userAuthProviders = sqliteTable(
  'user_auth_providers',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: enumText('provider', AUTH_PROVIDERS).notNull(),
    providerAccountId: text('provider_account_id'),
    linkedAt: text('linked_at').notNull(),
  },
  (table) => [
    uniqueIndex('ux_user_auth_providers').on(table.userId, table.provider),
    index('ix_user_auth_providers_account').on(table.provider, table.providerAccountId),
  ],
);

/* ------------------------------------------------------------------ app_settings */

export const appSettings = sqliteTable(
  'app_settings',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    key: text('key').notNull(),
    /** `Mixed`. Read by key and used whole; never filtered on. */
    value: text('value').notNull(),
    description: text('description').notNull().default(''),
    updatedBy: text('updated_by').references(() => users.id),
    ...timestampColumns,
  },
  (table) => [uniqueIndex('ux_app_settings_org_key').on(table.organizationId, table.key)],
);
