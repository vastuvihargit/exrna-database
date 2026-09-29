# Cloudflare Migration — Phase 3, Module 2: Roles and Permissions

**Status:** complete. MongoDB remains the live database. No UI file changed.
**Predecessors:** [`02-phase-2-d1-schema.md`](./02-phase-2-d1-schema.md) · [`03-phase-3-module-1-users-departments.md`](./03-phase-3-module-1-users-departments.md)

---

## 1. What this module produced

```
src/server/repositories/
  role.repository.contract.ts     neutral interface + assertScopeShape()
  role.repository.mongo.ts        existing implementation, two fixes (§5)
  role.repository.d1.ts           new
  role.repository.ts              façade — unchanged import path for all 11 callers
drizzle/migrations/
  0002_fix_user_roles_active_uniqueness.sql    hand-written — see §4
tests/d1/role-repository.test.ts  48 tests, both engines
```

`DATA_SOURCE_ROLES` is unset, so every call still goes to MongoDB.

**No caller changed.** Unlike module 1, this repository never leaked MongoDB syntax — no
`FilterQuery`, no `$set`. The only signature change was dropping an optional
`session?: ClientSession` parameter that no caller passed.

---

## 2. Five tables, one repository

`roles`, `permissions`, `role_permissions`, `role_scope_types`, `user_roles`. The two
array-valued fields MongoDB embedded — `roles.permissions[]` and `roles.scopeTypes[]` — are
child tables in D1, rebuilt in **two batched queries per call**. That batching matters more
here than anywhere else so far: `getActorGrants` runs on *every authenticated request*, so a
per-role query would have put an N+1 on the permission path.

---

## 3. Two listings that look alike and are not

`getActorGrants` excludes expired grants. `listGrantsForUser` does not.

That is not an inconsistency to clean up. The first answers "what may this person do right
now"; the second is the administrative view, where a grant that has expired is still a fact
about the account. Collapsing them would either hide history from the admin screen or hand a
permission to somebody whose grant ran out. Both behaviours are asserted, in both engines.

---

## 4. Two defects found in the Phase 2 schema

Both were found by writing this module's tests, and both are in `user_roles` — the table that
decides what every request is permitted to do.

### 4.1 Duplicate company-scope grants were possible in D1 — **fixed**

Migration 0000 emitted:

```sql
CREATE UNIQUE INDEX ux_user_roles_active
  ON user_roles (user_id, role_id, scope_type, scope_id)
  WHERE revoked_at IS NULL;
```

MongoDB's equivalent index treats two NULLs as **equal** and rejects a second active grant of
the same role at company scope. SQL treats two NULLs as **distinct**, so this index rejected
nothing when `scope_id IS NULL` — and `scope_id` is NULL for exactly one kind of grant:
**company scope, the most privileged one.**

Demonstrated against a real D1 before the fix: two identical active company-scope grants
inserted successfully; the department-scope equivalent was correctly rejected.

**Why it matters.** Grants are revoked by id. Two active duplicates mean an administrator
revokes a company-wide admin role, watches it disappear from the grant list, and the account
still holds it through the copy. `user.service.ts` calls `findActiveGrant` before granting, so
the ordinary path is protected — but that is a check-then-write, and the database constraint
is what is supposed to hold when two requests race it.

**The fix** is `drizzle/migrations/0002_fix_user_roles_active_uniqueness.sql`, which rebuilds
the index over `coalesce(scope_id, '')`. Applied while `user_roles` is empty; rebuilding a
unique index on a populated access-control table would need the duplicates resolved first, so
this is the cheapest the fix will ever be.

Phase 2's schema comment claimed the `COALESCE` was already there. It never was — there is no
`COALESCE` anywhere in migration 0000.

> **The migration is hand-written because drizzle-kit cannot emit an expression index.** Asked
> to, it splits `coalesce(scope_id, '')` on the comma and produces invalid SQL:
> ``CREATE UNIQUE INDEX … (`user_id`,`role_id`,`scope_type`,`coalesce("scope_id"`,` '')`)``.
> So this index joins FTS5, the immutability triggers and the permission seed in the category
> of "things the schema definition cannot express". The definition in `access.ts` is
> deliberately left matching what 0000 emitted, so `drizzle-kit generate` stays quiet instead
> of trying to revert 0002 on the next schema change — with a comment saying so. **If
> `user_roles` is ever regenerated from scratch, 0002 must be re-applied after it.**

### 4.2 The scope-shape invariant has no database constraint — **mitigated, not fixed**

`user-role.model.ts` enforces "company ⇒ no scopeId, every other scope ⇒ scopeId" with a
`pre('validate')` hook, so MongoDB rejects a malformed grant **regardless of which code wrote
it**. Phase 2's comment on `access.ts` claimed this "moves into the check constraint below".

There is no such constraint. The four CHECK constraints migration 0000 emits are all on the
inventory tables.

**Mitigation:** `assertScopeShape()` lives in the contract and is called by *both*
repositories, so nothing going through the repository layer can write a malformed grant, in
either database. A test asserts both refuse the same input.

**Still weaker than MongoDB**, where the hook also catches a direct model write. Closing it
properly means a table rebuild — SQLite cannot `ADD CONSTRAINT` — which is a heavier change
than a repository module should carry, and one that deserves its own review. **Recommended as
a separate migration 0003, and cheapest now while the table is empty.** Left for you to gate.

---

## 5. Two fixes to the MongoDB repository

Small, and both reduce divergence rather than change behaviour anyone depends on.

| Fix | Was | Now |
|---|---|---|
| `findActiveGrant` with an unparseable `scopeId` | `new Types.ObjectId('x')` **threw** | returns `null`, as D1 does |
| `listRoles` / `findRoleByKey` with an unparseable `organizationId` | threw | returns `[]` / `null` |

The first is the one that mattered: that function answers "is this already granted?", and an
exception on the way to "no" turns a duplicate-grant check into a 500.

---

## 6. What was deliberately not changed

**A soft-deleted role still confers its permissions.** `role.model.ts` includes
`softDeleteFields` but never calls `applySoftDeleteFilter`, so MongoDB returns soft-deleted
roles from `listRoles` *and* resolves them through `getActorGrants` today. Adding
`deleted_at IS NULL` to the D1 queries would revoke live permissions across the organization
the instant the flag flipped — a silent access change disguised as a clean-up. Asserted in both
engines so the behaviour is pinned rather than assumed. If it is wrong, it is wrong in both
databases and is a product decision.

**The "grant with no role" guard is kept even though it is unreachable in D1.**
`user_roles.role_id` has a foreign key, so a grant cannot outlive its role. The fail-closed
branch stays: an unreachable safety check on the permission path costs nothing next to
discovering later that the constraint was dropped.

---

## 7. Files

**Added (6):** `role.repository.{contract,mongo,d1}.ts`,
`drizzle/migrations/0002_fix_user_roles_active_uniqueness.sql`,
`tests/d1/role-repository.test.ts`, this document.

**Modified (3):**

| File | Change |
|---|---|
| `src/server/repositories/role.repository.ts` | now the façade |
| `src/server/db/schema/access.ts` | two comments corrected — see §4; the index definition itself is unchanged, deliberately |
| `tests/helpers/test-d1.ts` | applies all three migrations; splitter handles trigger bodies |

**Not modified:** every service, route, component, hook and DTO. No caller of this repository
needed a change.

### 7.1 A harness bug worth recording

The comment stripper was applied per *chunk* instead of per *line*, so a statement preceded by
a header comment was truncated to nothing. That silently dropped the `DROP INDEX` from
migration 0002, and the run then failed on the following `CREATE INDEX` with "index already
exists" — a failure that reads as though the migration is wrong when the harness was. Fixed,
with the reason written into the function.

---

## 8. Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ 1 pre-existing warning, unchanged from baseline |
| `tests/d1/role-repository.test.ts` | ✅ **48/48** |
| `npm run test:d1` (3 files) | ✅ **123/123** (48 roles + 63 users/departments + 12 schema contract) |
| `npm test` (full Mongo suite) | ✅ **680/680**, 46 files — unchanged from baseline |
| `wrangler d1 migrations apply --local` | ✅ 0002 applied, 3 commands |
| `npm run build` (Node) | ✅ `.next/standalone` present |
| `npm run cf:build` | ✅ server bundle 11.51 MB |

**Total: 803 tests passing across both configs.**

---

## 9. Schema changes

One migration, `0002`. It **drops and recreates a single index**; it creates no table, alters
no column and moves no data. Both statements are idempotent-safe to re-run
(`DROP INDEX IF EXISTS`).

---

## 10. Rollback

**Per module, no deploy:**

```bash
wrangler secret delete DATA_SOURCE_ROLES --env <environment>
```

**The migration**, if 0002 itself needs reverting:

```sql
DROP INDEX IF EXISTS ux_user_roles_active;
CREATE UNIQUE INDEX ux_user_roles_active
  ON user_roles (user_id, role_id, scope_type, scope_id)
  WHERE revoked_at IS NULL;
```

That restores the *defective* index, so it is a rollback of last resort — it re-opens §4.1.

**The module:**

```bash
git checkout -- src/server/repositories/role.repository.ts src/server/db/schema/access.ts tests
rm -f src/server/repositories/role.repository.{contract,mongo,d1}.ts \
      tests/d1/role-repository.test.ts
npm run typecheck && npm test
```

No D1 write path is reachable while `DATA_SOURCE_ROLES` is unset, and MongoDB was neither read
nor written differently by this module.

---

## 11. Carried forward

| Item | Phase |
|---|---|
| **Migration 0003 — CHECK constraint for the scope-shape invariant** (§4.2), cheapest while the table is empty | your call |
| `ux_user_roles_active` must be re-applied if `user_roles` is ever regenerated | any future schema change |
| Do any real `departments.created_by` values point at missing users? | 5 |
| `dataSourceSummary()` exported but not surfaced | 6 |
| Durable Object rate limiter | 3, before the Worker serves authenticated traffic |

---

## 12. Acceptance criteria

- [x] API response shapes remain stable — `RoleRecord`, `RoleGrant` and `GrantSummary` are
      unchanged, and the parity block compares them field for field
- [x] Existing frontend hooks continue working — no route, DTO, hook or component changed
- [x] Backend permission validation remains active — this module *is* that validation; the
      negative cases (revoked, expired, another user's grants) are asserted in both engines
- [x] Module tests pass before moving to the next module
- [x] No raw SQL in a UI component or an API route
- [x] `API route → service → permission check → repository → D1` preserved

---

## 13. Next

**Module 3 — projects and experiments.** It is also the first module that will exercise
`project_members`, which module 1 left populated only by tests — and the table the Phase 5
`users.projectIds[]` reconciliation depends on.
