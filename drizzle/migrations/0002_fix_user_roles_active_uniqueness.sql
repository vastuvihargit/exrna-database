-- ---------------------------------------------------------------------------------------
-- Phase 3, module 2 — close an access-control divergence between MongoDB and D1.
--
-- Hand-written, for the same reason migration 0001 is: drizzle-kit has no vocabulary for an
-- expression index. Asked to emit `coalesce(scope_id, '')` it splits the expression on the
-- comma and produces invalid SQL, so this index is owned by this file rather than by
-- `src/server/db/schema/access.ts`.
--
-- ── What was wrong ──────────────────────────────────────────────────────────────────────
--
-- `ux_user_roles_active` as emitted by migration 0000:
--
--     CREATE UNIQUE INDEX ux_user_roles_active
--       ON user_roles (user_id, role_id, scope_type, scope_id)
--       WHERE revoked_at IS NULL;
--
-- MongoDB's equivalent index treats two NULLs as **equal**, so it rejects a second active
-- grant of the same role to the same user at company scope. SQL treats two NULLs as
-- **distinct**, so the index above rejects nothing when `scope_id IS NULL` — and `scope_id`
-- is NULL for exactly one kind of grant: company scope, the most privileged one.
--
-- Demonstrated against a real D1 before this fix: two identical active company-scope grants
-- inserted successfully, where MongoDB rejects the second.
--
-- ── Why it matters ──────────────────────────────────────────────────────────────────────
--
-- Grants are revoked by id. Two active duplicates mean an administrator revokes a company-wide
-- admin role, sees it disappear from the grant list, and the account still holds it through
-- the duplicate. `user.service.ts` calls `findActiveGrant` before granting, so the ordinary
-- path is protected — but that is a check-then-write, and the database constraint is what is
-- supposed to hold when two requests race it.
--
-- ── The fix ─────────────────────────────────────────────────────────────────────────────
--
-- `coalesce(scope_id, '')` maps NULL onto a real value so the uniqueness comparison behaves
-- the way MongoDB's does. The empty string cannot collide with a genuine scope id: every
-- non-company scope id is an ObjectId hex or a UUID, and `assertScopeShape()` refuses a
-- non-company grant with an empty scope id before it reaches SQL.
--
-- Applied while `user_roles` is empty. Rebuilding a unique index on a populated
-- access-control table would need the duplicates resolved first, and this is the cheapest
-- this fix will ever be.
-- ---------------------------------------------------------------------------------------

DROP INDEX IF EXISTS `ux_user_roles_active`;--> statement-breakpoint

CREATE UNIQUE INDEX `ux_user_roles_active`
  ON `user_roles` (`user_id`, `role_id`, `scope_type`, coalesce(`scope_id`, ''))
  WHERE revoked_at IS NULL;
