-- ---------------------------------------------------------------------------------------
-- Phase 3, module 3.5 — put the role-grant scope invariant in the database.
--
-- ── The invariant ───────────────────────────────────────────────────────────────────────
--
-- A role is granted at a scope. The valid combinations are:
--
--     scope_type     scope_id      meaning
--     ------------   -----------   ------------------------------------------------------
--     'company'      NULL          applies across the whole organization
--     'department'   required      applies within one department
--     'project'      required      applies within one project
--     'folder'       required      applies within one folder subtree
--     'file'         required      applies to one file
--
-- Two things must be true, and neither was enforced by the database:
--
--   1. `scope_type` is one of those five values.
--   2. `scope_type = 'company'` carries no `scope_id`; every other scope requires one.
--
-- MongoDB enforced (2) with a `pre('validate')` hook on `user-role.model.ts` and (1) with a
-- schema `enum`, so a malformed grant was rejected **regardless of which code wrote it** —
-- a fixture, a seed script, a migration, or a hand-typed statement during an incident.
--
-- Phase 2's comment on `access.ts` claimed the hook "moves into the check constraint below".
-- It did not: the four CHECK constraints migration 0000 emits are all on the inventory
-- tables. Until this migration, the rule lived only in `assertScopeShape()` in the repository
-- contract — which covers every application path, and nothing else.
--
-- ── Why `scope_id = ''` is forbidden as well as NULL ────────────────────────────────────
--
-- Migration 0002 rebuilt `ux_user_roles_active` over `coalesce(scope_id, '')`, mapping NULL
-- onto the empty string so that duplicate company-scope grants collide the way MongoDB makes
-- them collide. That makes `''` the sentinel for "company scope" inside the unique index.
--
-- A non-company grant stored with `scope_id = ''` would therefore be treated as
-- indistinguishable from a company-scope grant of the same user and role — one would silently
-- block the other. The CHECK forbids it, which keeps 0002's sentinel unambiguous.
--
-- ── Why a table rebuild rather than a trigger ───────────────────────────────────────────
--
-- SQLite has no `ALTER TABLE ... ADD CONSTRAINT`, so a CHECK can only be added by rebuilding
-- the table. The alternative — BEFORE INSERT / BEFORE UPDATE triggers raising ABORT, the
-- pattern migration 0001 uses for the append-only tables — would enforce the same rule
-- without moving any data.
--
-- The rebuild is chosen because a CHECK is **part of the table definition**: it cannot be
-- dropped without altering the table, it is visible in `sqlite_master` to anyone inspecting
-- the schema, and it applies to every future write path without anyone remembering it exists.
-- A trigger is a separate object that a later migration can drop by name.
--
-- The rebuild is safe here specifically because:
--
--   * **nothing references `user_roles` by foreign key** (verified against 0000), so no
--     inbound constraint breaks when the old table is dropped;
--   * the table is empty in every environment at the point this migration runs — Phase 5 has
--     not loaded anything yet — so the copy step moves nothing and cannot fail on bad data;
--   * all four indexes are recreated explicitly below, including 0002's expression index.
--
-- **Pre-flight check.** If this is ever applied to a populated `user_roles`, run this first;
-- it must return zero rows, or the copy step will abort on the CHECK:
--
--     SELECT id, scope_type, scope_id FROM user_roles
--      WHERE scope_type NOT IN ('company','department','project','folder','file')
--         OR (scope_type =  'company' AND scope_id IS NOT NULL)
--         OR (scope_type <> 'company' AND (scope_id IS NULL OR scope_id = ''));
--
-- Aborting is the correct outcome there: it means grants exist that MongoDB would have
-- rejected, and they need deciding on rather than copying forward.
--
-- ── Known limitation ────────────────────────────────────────────────────────────────────
--
-- `drizzle-kit` cannot express a table-level CHECK for this table, and its snapshot still
-- describes the pre-0003 shape. `access.ts` is deliberately left matching what 0000 emitted
-- so `drizzle-kit generate` stays quiet rather than trying to revert this. **If `user_roles`
-- is ever regenerated from the schema definition, 0002 and 0003 must both be re-applied
-- afterwards.** Same caveat as FTS5, the immutability triggers and the permission seed.
--
-- Repository-level `assertScopeShape()` stays in place as defence in depth: it produces a
-- clear application error at the call site, where this produces a constraint failure.
-- ---------------------------------------------------------------------------------------

CREATE TABLE `user_roles_new` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`granted_by` text,
	`granted_at` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`revoked_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_user_roles_scope_type" CHECK(
		scope_type IN ('company', 'department', 'project', 'folder', 'file')
	),
	CONSTRAINT "ck_user_roles_scope_shape" CHECK(
		(scope_type =  'company' AND scope_id IS NULL)
		OR
		(scope_type <> 'company' AND scope_id IS NOT NULL AND scope_id <> '')
	)
);--> statement-breakpoint

INSERT INTO `user_roles_new`
	(`id`, `organization_id`, `user_id`, `role_id`, `scope_type`, `scope_id`,
	 `granted_by`, `granted_at`, `expires_at`, `revoked_at`, `revoked_by`,
	 `created_at`, `updated_at`)
SELECT
	`id`, `organization_id`, `user_id`, `role_id`, `scope_type`, `scope_id`,
	`granted_by`, `granted_at`, `expires_at`, `revoked_at`, `revoked_by`,
	`created_at`, `updated_at`
FROM `user_roles`;--> statement-breakpoint

DROP TABLE `user_roles`;--> statement-breakpoint

ALTER TABLE `user_roles_new` RENAME TO `user_roles`;--> statement-breakpoint

-- Indexes are not carried over by a rename; all four are recreated here.
-- `ux_user_roles_active` is the **0002** form, over coalesce(scope_id, ''), not the 0000 one.
CREATE UNIQUE INDEX `ux_user_roles_active`
	ON `user_roles` (`user_id`, `role_id`, `scope_type`, coalesce(`scope_id`, ''))
	WHERE revoked_at IS NULL;--> statement-breakpoint

CREATE INDEX `ix_user_roles_user` ON `user_roles` (`user_id`,`revoked_at`);--> statement-breakpoint

CREATE INDEX `ix_user_roles_scope` ON `user_roles` (`scope_type`,`scope_id`,`revoked_at`);--> statement-breakpoint

CREATE INDEX `ix_user_roles_expiry` ON `user_roles` (`expires_at`);
