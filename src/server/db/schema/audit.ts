/**
 * Audit log, sessions, login history, activity feed and per-user state.
 */
import { index, sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { AUDIT_ACTIONS, AUDIT_OUTCOMES } from '@/server/db/models/audit-log.model';
import { LOGIN_OUTCOMES } from '@/server/db/models/login-history.model';
import { SESSION_REVOKE_REASONS } from '@/server/db/models/session.model';
import { ACTIVITY_ENTITY_TYPES } from '@/server/db/models/activity.model';
import { RECENT_ENTITY_TYPES } from '@/server/db/models/recent-item.model';
import { STARRABLE_TYPES } from '@/server/db/models/star.model';
import { boolean, createdAtColumn, enumText, timestampColumns } from './_shared';
import { departments, organizations, users } from './identity';
import { projects } from './research';
import { folders } from './drive';

/* ------------------------------------------------------------------ audit_logs */

/**
 * Append-only compliance record.
 *
 * MongoDB enforced immutability in three layers; two carry over directly (the repository
 * exposes only append and query, and in production the database user is scoped). The third —
 * pre-hooks rejecting every update and delete — becomes `RAISE(ABORT)` triggers, created in
 * migration 0001 alongside the ones on `stock_transactions`.
 *
 * There is deliberately **no TTL and no retention index**: retention is applied by an
 * explicit, audited archival job, never silently by the database.
 */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').references(() => organizations.id),

    actorUserId: text('actor_user_id').references(() => users.id),
    actorEmail: text('actor_email'),
    /** The actor's role keys at the time of the action, as a JSON array. */
    actorRoleKeys: text('actor_role_keys').notNull().default('[]'),

    action: enumText('action', AUDIT_ACTIONS).notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    entityLabel: text('entity_label'),

    /** `Mixed` in MongoDB — an arbitrary before/after snapshot, read whole. */
    previousValue: text('previous_value'),
    newValue: text('new_value'),
    /** Required for sensitive actions (purge, permission change, deactivation). */
    reason: text('reason'),

    ip: text('ip').notNull().default('unknown'),
    userAgent: text('user_agent').notNull().default('unknown'),
    requestId: text('request_id'),

    outcome: enumText('outcome', AUDIT_OUTCOMES).notNull().default('success'),
    severity: enumText('severity', ['info', 'notice', 'warning', 'critical'] as const)
      .notNull()
      .default('info'),

    ...createdAtColumn,
  },
  (table) => [
    index('ix_audit_logs_org').on(table.organizationId, table.createdAt),
    index('ix_audit_logs_actor').on(table.actorUserId, table.createdAt),
    index('ix_audit_logs_entity').on(table.entityType, table.entityId, table.createdAt),
    index('ix_audit_logs_action').on(table.action, table.createdAt),
    index('ix_audit_logs_request').on(table.requestId),
    index('ix_audit_logs_outcome').on(table.outcome, table.createdAt),
  ],
);

/* ------------------------------------------------------------------ sessions */

/**
 * Server-side sessions.
 *
 * Retained through Phase 8 rather than dropped: Cloudflare Access holds the session once it
 * is live, but the Node deployment is the rollback path until the window expires, and it
 * needs these rows to authenticate anyone at all.
 *
 * MongoDB expired rows with a TTL index on `absoluteExpiresAt`. SQLite has no TTL, so the
 * database no longer sweeps them — the application already refuses an expired session on
 * every read, and a cleanup job removes them. That is a real behavioural difference and it is
 * why `ix_sessions_absolute_expiry` exists: the sweep needs to find them cheaply.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),

    /** Only the SHA-256 — a database leak does not yield usable session cookies. */
    tokenHash: text('token_hash').notNull(),
    csrfTokenHash: text('csrf_token_hash').notNull(),

    /** Idle expiry, extended on use; absolute expiry is never extended. */
    expiresAt: text('expires_at').notNull(),
    absoluteExpiresAt: text('absolute_expires_at').notNull(),
    lastUsedAt: text('last_used_at').notNull(),

    rotatedFromId: text('rotated_from_id').references((): AnySQLiteColumn => sessions.id),
    rotatedAt: text('rotated_at'),

    ip: text('ip').notNull().default('unknown'),
    userAgent: text('user_agent').notNull().default('unknown'),
    deviceLabel: text('device_label').notNull().default('Unknown device'),
    provider: text('provider').notNull().default('password'),

    revokedAt: text('revoked_at'),
    revokedReason: enumText('revoked_reason', SESSION_REVOKE_REASONS),

    ...timestampColumns,
  },
  (table) => [
    /** The authentication hot path — every request resolves a session by token hash. */
    uniqueIndex('ux_sessions_token_hash').on(table.tokenHash),
    index('ix_sessions_user').on(table.userId, table.revokedAt, table.expiresAt),
    /** Replaces the Mongo TTL index; read by the cleanup job, not by the database. */
    index('ix_sessions_absolute_expiry').on(table.absoluteExpiresAt),
  ],
);

/* ------------------------------------------------------------------ login_history */

/**
 * Every authentication attempt, successful or not.
 *
 * `userId` is null when the address matches no account — the row still records the attempt
 * so credential stuffing shows up in the admin view.
 *
 * The Mongo 400-day TTL is likewise replaced by the cleanup job; the permanent record of a
 * security event is the audit log, which has no expiry at all.
 */
export const loginHistory = sqliteTable(
  'login_history',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id),
    email: text('email').notNull(),
    outcome: enumText('outcome', LOGIN_OUTCOMES).notNull(),
    provider: text('provider').notNull().default('password'),
    ip: text('ip').notNull().default('unknown'),
    userAgent: text('user_agent').notNull().default('unknown'),
    sessionId: text('session_id').references(() => sessions.id),
    detail: text('detail'),
    ...createdAtColumn,
  },
  (table) => [
    index('ix_login_history_user').on(table.userId, table.createdAt),
    index('ix_login_history_email').on(table.email, table.createdAt),
    index('ix_login_history_outcome').on(table.outcome, table.createdAt),
    index('ix_login_history_ip').on(table.ip, table.createdAt),
    index('ix_login_history_retention').on(table.createdAt),
  ],
);

/* ------------------------------------------------------------------ password_reset_tokens */

export const passwordResetTokens = sqliteTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    expiresAt: text('expires_at').notNull(),
    /** Consumed rather than deleted, so a replay is distinguishable from an unknown token. */
    usedAt: text('used_at'),
    requestedIp: text('requested_ip').notNull().default('unknown'),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('ux_password_reset_tokens_hash').on(table.tokenHash),
    index('ix_password_reset_tokens_user').on(table.userId, table.usedAt),
    index('ix_password_reset_tokens_expiry').on(table.expiresAt),
  ],
);

/* ------------------------------------------------------------------ activities */

/**
 * The user-facing "what happened here" timeline.
 *
 * Deliberately not the audit log: that is an append-only compliance record normal users
 * cannot read; this is permission-filtered per viewer and may be pruned by retention.
 * Writing one does not replace writing the other.
 */
export const activities = sqliteTable(
  'activities',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => users.id),
    actorName: text('actor_name').notNull(),

    /** Verb from the audit vocabulary, e.g. `folder.create`. */
    action: text('action').notNull(),
    entityType: enumText('entity_type', ACTIVITY_ENTITY_TYPES).notNull(),
    entityId: text('entity_id').notNull(),
    entityLabel: text('entity_label').notNull().default(''),

    departmentId: text('department_id').references(() => departments.id),
    projectId: text('project_id').references(() => projects.id),

    detail: text('detail'),
    ...createdAtColumn,
  },
  (table) => [
    index('ix_activities_entity').on(table.entityType, table.entityId, table.createdAt),
    index('ix_activities_org').on(table.organizationId, table.createdAt),
    index('ix_activities_actor').on(table.actorUserId, table.createdAt),
    index('ix_activities_project').on(table.projectId, table.createdAt),
  ],
);

/** `activities.contextFolderIds[]` — so a folder timeline can include its subtree. */
export const activityFolders = sqliteTable(
  'activity_folders',
  {
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('ux_activity_folders').on(table.activityId, table.folderId),
    index('ix_activity_folders_folder').on(table.folderId),
  ],
);

/* ------------------------------------------------------------------ stars & recent */

/**
 * A star belongs to the person who set it, not to the resource — otherwise one employee
 * starring a shared protocol would star it for the whole department.
 */
export const stars = sqliteTable(
  'stars',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    entityType: enumText('entity_type', STARRABLE_TYPES).notNull(),
    entityId: text('entity_id').notNull(),
    ...createdAtColumn,
  },
  (table) => [
    /** Starring twice is a no-op rather than a second row. */
    uniqueIndex('ux_stars').on(table.userId, table.entityType, table.entityId),
    index('ix_stars_user').on(table.userId, table.createdAt),
  ],
);

/**
 * "Recent" — one row per (user, item), upserted on access.
 *
 * Stored separately from the activity feed on purpose: a GROUP BY over an ever-growing
 * activity table to find each user's last twenty items is the query that quietly stops
 * finishing once the table is large.
 */
export const recentItems = sqliteTable(
  'recent_items',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    entityType: enumText('entity_type', RECENT_ENTITY_TYPES).notNull(),
    entityId: text('entity_id').notNull(),
    /** `opened` | `edited` | `uploaded`. */
    lastAction: text('last_action').notNull().default('opened'),
    lastAccessedAt: text('last_accessed_at').notNull(),
  },
  (table) => [
    uniqueIndex('ux_recent_items').on(table.userId, table.entityType, table.entityId),
    index('ix_recent_items_user').on(table.userId, table.lastAccessedAt),
  ],
);

/* ------------------------------------------------------------------ saved_searches */

/**
 * Stores the *criteria*, never the results. Results are re-run through the permission filter
 * on every open, so a saved search cannot become a stale window onto a file the owner later
 * restricted — which is exactly what caching result ids would create.
 */
export const savedSearches = sqliteTable(
  'saved_searches',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    nameLower: text('name_lower').notNull(),
    /** JSON, re-parsed through `searchQuerySchema.parse()` on every read. */
    criteria: text('criteria').notNull(),

    isPinned: boolean('is_pinned').notNull().default(false),
    lastRunAt: text('last_run_at'),
    runCount: integer('run_count').notNull().default(0),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('ux_saved_searches_user_name').on(table.userId, table.nameLower),
    index('ix_saved_searches_user').on(table.userId, table.isPinned, table.updatedAt),
  ],
);
