/**
 * Roles, permissions and access-control entries.
 *
 * This is where the flattest part of the MongoDB model becomes the most normalized part of
 * the D1 one, and it is the file that most directly decides whether the migration preserves
 * who can see what.
 */
import { index, sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import {
  ACCESS_LEVELS,
  CONFIDENTIALITY_LEVELS,
  PERMISSIONS,
  PRINCIPAL_TYPES,
  SCOPE_TYPES,
} from '@/server/domain/permissions';
import { boolean, enumText, softDeleteColumns, timestampColumns } from './_shared';
import { departments, organizations, users } from './identity';

/* ------------------------------------------------------------------ permissions */

/**
 * The permission catalogue — one row per value in `domain/permissions.ts`.
 *
 * A lookup table rather than a bare string on `role_permissions`, because the brief asks for
 * a `permissions` table and because it gives the join a foreign key: a typo'd permission
 * name then fails at insert instead of silently granting nothing. Seeded by migration, never
 * written at runtime.
 */
export const permissions = sqliteTable('permissions', {
  key: enumText('key', PERMISSIONS).primaryKey(),
  description: text('description').notNull().default(''),
});

/* ------------------------------------------------------------------ roles */

export const roles = sqliteTable(
  'roles',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),

    /** "You cannot grant a role at or above your own privilege level." */
    rank: integer('rank').notNull(),
    maxConfidentiality: enumText('max_confidentiality', CONFIDENTIALITY_LEVELS)
      .notNull()
      .default('internal'),
    companyWideRead: boolean('company_wide_read').notNull().default(false),

    isSystem: boolean('is_system').notNull().default(false),
    createdBy: text('created_by').references(() => users.id),
    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('ux_roles_org_key').on(table.organizationId, table.key),
    index('ix_roles_org_rank').on(table.organizationId, table.rank),
  ],
);

/* ------------------------------------------------------------------ role_permissions */

/** `roles.permissions[]`. */
export const rolePermissions = sqliteTable(
  'role_permissions',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: enumText('permission_key', PERMISSIONS)
      .notNull()
      .references(() => permissions.key),
  },
  (table) => [
    // Composite primary key: a role cannot hold a permission twice, and the pair is the
    // only way this table is ever read.
    uniqueIndex('ux_role_permissions').on(table.roleId, table.permissionKey),
    index('ix_role_permissions_permission').on(table.permissionKey),
  ],
);

/** `roles.scopeTypes[]` — which scopes a role may be granted at. */
export const roleScopeTypes = sqliteTable(
  'role_scope_types',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    scopeType: enumText('scope_type', SCOPE_TYPES).notNull(),
  },
  (table) => [uniqueIndex('ux_role_scope_types').on(table.roleId, table.scopeType)],
);

/* ------------------------------------------------------------------ user_roles */

export const userRoles = sqliteTable(
  'user_roles',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id),

    scopeType: enumText('scope_type', SCOPE_TYPES).notNull(),
    /**
     * Null for a company-scope grant, set for every other scope.
     *
     * Deliberately **not** a foreign key: the target is a department, project, folder or
     * file depending on `scopeType`, and SQL has no polymorphic reference.
     *
     * ── Correction (Phase 3, module 2) ────────────────────────────────────────────────
     *
     * This comment previously claimed that `user-role.model.ts`'s `pre('validate')` hook —
     * "company ⇒ no scopeId, otherwise ⇒ scopeId" — had moved "into the check constraint
     * below, so the invariant stays in the database". **There is no such constraint.** The
     * four CHECK constraints migration 0000 emits are all on the inventory tables; drizzle-kit
     * has no vocabulary for a table-level CHECK here and none was hand-written into 0001.
     *
     * The rule is currently enforced by `assertScopeShape()` in
     * `repositories/role.repository.contract.ts`, called by both repositories, so no writer
     * going through the repository layer can produce a malformed grant. That is weaker than
     * MongoDB, where the hook catches a direct model write too.
     *
     * Closing the gap properly means rebuilding this table — SQLite cannot ADD CONSTRAINT —
     * which is cheap while `user_roles` is empty and expensive after Phase 5 loads it. It is
     * recorded as a recommendation in
     * `docs/cloudflare-migration/04-phase-3-module-2-roles-permissions.md` §4 rather than
     * smuggled into a repository module.
     */
    scopeId: text('scope_id'),

    grantedBy: text('granted_by').references(() => users.id),
    grantedAt: text('granted_at').notNull(),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
    revokedBy: text('revoked_by').references(() => users.id),
    ...timestampColumns,
  },
  (table) => [
    /**
     * A user cannot hold the same role twice at the same scope **while it is active**.
     *
     * Partial, exactly as the Mongo `partialFilterExpression: { revokedAt: null }` was:
     * grants are revoked rather than deleted so the history survives in the audit trail, and
     * a plain unique index would stop a role ever being re-granted after revocation.
     *
     * `COALESCE` because SQL treats two NULLs as distinct in a unique index while MongoDB
     * treats them as equal. Without it this index constrains department-, project-, folder-
     * and file-scope grants and silently permits duplicate **company-scope** grants — the most
     * privileged kind — because their `scope_id` is NULL.
     *
     * That is not hypothetical: it was demonstrated against migration 0000 before being fixed
     * (Phase 3 module 2). The consequence is that revoking one of two duplicate grants leaves
     * the other active, so an administrator revokes an admin role and the account keeps it.
     *
     * ⚠️ **The deployed index is not the one written below.** `drizzle-kit` cannot emit an
     * expression index — asked to, it splits `coalesce(scope_id, '')` on the comma and
     * produces invalid SQL. So this index joins FTS5, the immutability triggers and the
     * permission seed in the category of "things the schema definition cannot express", and
     * it is owned by a hand-written migration:
     *
     *     drizzle/migrations/0002_fix_user_roles_active_uniqueness.sql
     *
     * The definition below is kept identical to what 0000 emitted so that `drizzle-kit
     * generate` stays quiet rather than trying to revert 0002 on the next schema change. If
     * this table is ever regenerated from scratch, 0002 must be re-applied after it.
     * `docs/cloudflare-migration/04-phase-3-module-2-roles-permissions.md` §4 has the detail.
     */
    uniqueIndex('ux_user_roles_active')
      .on(table.userId, table.roleId, table.scopeType, table.scopeId)
      .where(sql`revoked_at IS NULL`),
    index('ix_user_roles_user').on(table.userId, table.revokedAt),
    index('ix_user_roles_scope').on(table.scopeType, table.scopeId, table.revokedAt),
    index('ix_user_roles_expiry').on(table.expiresAt),
  ],
);

/* ------------------------------------------------------------------ resource_permissions */

/**
 * The ACL entries that were embedded arrays on `folders` and `files`.
 *
 * ── Why this is a table and not a JSON column ──────────────────────────────────────────
 *
 * `resourceVisibilityFilter()` matches `permissions.principalId` inside the *listing* query —
 * it is how "anything shared with me, my department, my projects or my roles" is answered in
 * one indexed pass. A JSON column would turn every drive listing into a full scan with
 * `json_each`, which is the query that stops finishing once the corpus is real.
 *
 * ── Why one table for two resource types ───────────────────────────────────────────────
 *
 * Folders and files carry identical entries and are permission-checked by the same code
 * (`aclGrants()` takes an entry list and does not care what it hangs off). Two tables would
 * be two identical schemas, two indexes and a union in every visibility query.
 *
 * The cost is that `resource_id` cannot be a foreign key — it points at `folders` or `files`
 * depending on `resource_type`. That is accepted here, and the Phase 5 migration validates
 * every row resolves.
 */
export const resourcePermissions = sqliteTable(
  'resource_permissions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),

    resourceType: enumText('resource_type', ['folder', 'file'] as const).notNull(),
    resourceId: text('resource_id').notNull(),

    principalType: enumText('principal_type', PRINCIPAL_TYPES).notNull(),
    /** A user, department, project or role id — polymorphic for the same reason. */
    principalId: text('principal_id').notNull(),
    accessLevel: enumText('access_level', ACCESS_LEVELS).notNull(),

    /** An explicit deny beats every allow, including an inherited one. */
    deny: boolean('deny').notNull().default(false),
    expiresAt: text('expires_at'),
    grantedBy: text('granted_by').references(() => users.id),
    grantedAt: text('granted_at').notNull(),
  },
  (table) => [
    // The listing hot path: "which resources is this principal named on?"
    index('ix_resource_permissions_principal').on(table.principalId, table.principalType),
    // The detail path: "what are the entries on this resource?"
    index('ix_resource_permissions_resource').on(table.resourceType, table.resourceId),
    // Denies are checked first and separately; keeping them indexed means the deny guard in
    // `childVisibilityFilter()` does not have to read every entry on the resource.
    index('ix_resource_permissions_deny')
      .on(table.resourceType, table.resourceId, table.principalId)
      .where(sql`deny = 1`),
    // One entry per principal per resource, matching MAX_ACL_ENTRIES-bounded array semantics
    // where a second grant to the same principal replaced the first.
    uniqueIndex('ux_resource_permissions').on(
      table.resourceType,
      table.resourceId,
      table.principalType,
      table.principalId,
    ),
  ],
);

/* ------------------------------------------------------------------ department heads */

/**
 * Re-exported for the relations file. Declared in `identity.ts` to keep the
 * organization → department → user chain in one place.
 */
export { departments, organizations, users };
