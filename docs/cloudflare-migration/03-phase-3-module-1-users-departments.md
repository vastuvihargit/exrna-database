# Cloudflare Migration — Phase 3, Module 1: Users and Departments

**Status:** complete. MongoDB remains the live database. No UI file changed.
**Predecessors:** [`00-phase-0-analysis.md`](./00-phase-0-analysis.md) · [`01-phase-1-worker.md`](./01-phase-1-worker.md) · [`02-phase-2-d1-schema.md`](./02-phase-2-d1-schema.md)

---

## 1. What this module produced

Two repositories that exist twice — once against Mongoose, once against Drizzle/D1 — behind a
façade that picks one per call from an environment variable.

```
src/server/repositories/
  data-source.ts                        the per-module flag
  user.repository.contract.ts           the database-neutral interface
  user.repository.mongo.ts              existing implementation, signatures narrowed
  user.repository.d1.ts                 new
  user.repository.ts                    façade — unchanged import path for all 9 callers
  department.repository.{contract,mongo,d1}.ts
  department.repository.ts              façade
src/server/db/d1-context.ts             how a repository obtains the binding
tests/helpers/test-d1.ts                Miniflare harness
tests/d1/user-department-repository.test.ts   63 tests, both engines
```

**`DATA_SOURCE_USERS` and `DATA_SOURCE_DEPARTMENTS` are unset**, so every call still goes to
MongoDB. Nothing about the running system changed.

---

## 2. The problem that shaped the design

The Mongoose repositories leaked their query language upward:

```ts
userRepository.list({ filter: userDirectoryFilter(actor), page, pageSize })  // FilterQuery
userRepository.updateById(userId, { $set: update })                          // Mongo operator
```

`$set` and `FilterQuery` are MongoDB syntax, and both were being **constructed inside
services**. "Replace the repository" therefore meant "and rewrite the callers", with no
intermediate state in which the two implementations could be run against the same inputs.

So the first change was a neutral contract, and the leak turned out to be small: nine call
sites, and `userDirectoryFilter` / `departmentVisibilityFilter` both reduce to
`{ organizationId }`. The other 24 uses of these repositories are `findById` / `findByIds`,
whose signatures did not change at all.

### 2.1 A constraint that got stronger

`organizationId` is now a **required named field** on `ListUsersCriteria` rather than a key
inside an opaque filter object. A listing with no tenant predicate previously type-checked —
`dev-switcher.service.ts` passed `filter: {}` and listed every account in every organization.
It now cannot be written, and that call site was corrected to scope to the primary
organization.

---

## 3. Where D1 is not a transliteration of the Mongo query

| # | Field | MongoDB | D1 |
|---|---|---|---|
| 1 | `projectIds` | `users.projectIds[]` array column | join on `project_members` |
| 2 | `authProviders` | `users.authProviders[]` sub-documents | join on `user_auth_providers` |
| 3 | `updatedAt` | maintained by `timestamps: true` | written explicitly on every write path |

(1) is the deliberate data-model change from Phase 2 §4 — MongoDB stored project membership
twice and D1 keeps one copy. The exposed contract is unchanged, and a parity test asserts both
databases report the same `projectIds` for the same logical fact.

(1) and (2) are loaded in **two batched queries per listing**, not two per row. The N+1 version
is invisible on a developer's twelve-row database and is the entire cost of the endpoint on a
400-employee directory.

(3) has no loud failure mode, which is why it is called out: a missing `updated_at` would not
break anything, it would just quietly stop being true. There is a test.

---

## 4. What was deliberately *not* changed

**No `deleted_at IS NULL` predicate was added.** `user.model.ts` and `department.model.ts`
include the soft-delete *fields* but do not call `applySoftDeleteFilter` — only `comment`,
`experiment`, `file`, `folder` and `inventory-item` do. So MongoDB returns soft-deleted users
and departments from these queries **today**, and `isActive: false` is what actually hides a
deleted department downstream.

Adding the filter would have looked like a tidy-up and would have been a silent behaviour
change: a department visible before the flag flipped would vanish after it. `includeDeleted`
is spelled out in the contract so the choice is a decision on the page rather than an omission,
and a test asserts the default listing still contains a soft-deleted row **in both databases**.

---

## 5. How a repository gets the binding

`d1.ts` takes the binding as an argument, because a module-scope lookup in a Worker captures
the wrong request's context. That left the question of where the caller gets it, given that no
service in this codebase threads a database handle through its arguments — and threading one
through would have meant changing every service and every route.

`d1-context.ts` resolves it per call from the ambient request context:

| Runtime | Source |
|---|---|
| Worker | `getCloudflareContext().env.DB` — OpenNext scopes it to the in-flight request via AsyncLocalStorage |
| Tests | an explicitly injected Miniflare binding |
| Node server | none — throws a message naming the misconfiguration |

The `@opennextjs/cloudflare` import is **dynamic**, so it stays out of the Node bundle's module
graph. The Node production build is unaffected (§8).

---

## 6. Testing: two real databases in one process

`tests/d1/schema-contract.test.ts` shells out to wrangler, which is right for 12 assertions at
10 s each. A repository suite makes hundreds of calls, and at a process spawn each it would
take an hour — and a suite that takes an hour is one people stop running.

`tests/helpers/test-d1.ts` embeds **Miniflare**, the same workerd SQLite `wrangler dev --local`
uses, and hands back a real `D1Database`. Calls go through the actual binding API — prepared
statements, `batch()`, `RETURNING` — without a process boundary. Foreign keys are enforced
(verified: `PRAGMA foreign_keys` returns 1).

Only migration 0000 is applied. 0001's triggers are on `files`, `folders`, `experiments`,
`audit_logs` and `stock_transactions`; it does not mention `users` or `departments` anywhere
(`grep -c '\busers\b\|\bdepartments\b'` → 0). A later module's suite applies it.

### 6.1 The parity block is the load-bearing part

`describe.each` over both engines proves each implementation is individually correct. It cannot
prove they **agree**. The parity block creates the same logical record through both
repositories and compares them field by field, with ids mapped to symbolic names and dates
reduced to the marker `<Date>` — *not* dropped, because a D1 `TEXT` column arriving as a string
where Mongo yields a `Date` is exactly the class of bug this must catch.

### 6.2 A foreign key caught a fixture bug that MongoDB has been tolerating

The first draft attributed fixture departments to the organization id. MongoDB accepted it —
it stores whatever ObjectId it is given. D1 rejected it, because `departments.created_by`
carries a real foreign key to `users.id`, and eight tests failed.

The constraint was right. The Mongo database has been able to hold a department attributed to
a non-existent employee all along. The fixture now requires a real user, and the reason is
written into the test rather than worked around.

*(This is a property of the schema, not of production data. Whether any real row is affected is
a Phase 5 relationship-validation question, and it is recorded in §11 as such.)*

---

## 7. Files

### 7.1 Added (10)

```
src/server/repositories/data-source.ts
src/server/repositories/user.repository.contract.ts
src/server/repositories/user.repository.mongo.ts
src/server/repositories/user.repository.d1.ts
src/server/repositories/department.repository.contract.ts
src/server/repositories/department.repository.mongo.ts
src/server/repositories/department.repository.d1.ts
src/server/db/d1-context.ts
tests/helpers/test-d1.ts
tests/d1/user-department-repository.test.ts
docs/cloudflare-migration/03-phase-3-module-1-users-departments.md
```

### 7.2 Modified (9)

| File | Change |
|---|---|
| `src/server/repositories/user.repository.ts` | now the façade |
| `src/server/repositories/department.repository.ts` | now the façade |
| `src/server/permissions/visibility.ts` | `userDirectoryFilter` / `departmentVisibilityFilter` return `{ organizationId: string }` |
| `src/server/services/user.service.ts` | 4 call sites: criteria instead of `filter`, patch instead of `$set` |
| `src/server/services/department.service.ts` | 2 call sites |
| `src/server/services/dev-switcher.service.ts` | tenant-scoped listing; imports `organizationRepository` |
| `tests/security/file-upload.test.ts` | 2 sites, `$set` → patch |
| `tests/security/preview-download.test.ts` | 2 sites |
| `tests/security/sharing-and-collaboration.test.ts` | 2 sites |
| `package.json` | `miniflare` devDependency (was transitive via wrangler) |

`drive.service.ts` needed **no change**: `departmentVisibilityFilter(actor)` now returns
exactly `ListDepartmentsCriteria`.

### 7.3 Not modified

Every component, page, hook and API route. All 24 other repositories. `connection.ts`.
Every Mongoose model. `resourceVisibilityFilter` and the rest of `visibility.ts` stay
MongoDB-shaped until folders and files move in module 4.

---

## 8. Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ 1 pre-existing warning, unchanged from baseline |
| `tests/d1/user-department-repository.test.ts` | ✅ **63/63** |
| `npm run test:d1` (both D1 files) | ✅ **75/75** (63 new + 12 schema contract) |
| `npm test` (full Mongo suite) | ✅ **680/680**, 46 files — unchanged from the Phase 1 baseline |
| `npm run build` (Node) | ✅ `.next/standalone` present |
| `npm run cf:build` | ✅ server bundle 11.51 MB (was 11.35 MB — drizzle-orm and the two D1 repositories) |
| `wrangler dev --local` | ✅ boots and serves |

The Worker preview reproduces the Phase 1 results exactly: `/login` at the same 16,432 bytes,
`/` → 307, a guessed file id → 401 with no information disclosure, security headers intact,
`x-request-id` present. `/api/health/ready` still reports `storage: degraded` (Phase 0
Finding 1) and MongoDB `ok` — the Worker is still reading Mongo, which is the point.

**Total: 755 tests passing across both configs.**

---

## 9. Schema changes

**None.** This module writes to tables that Phase 2 already created. No migration was added,
no Mongoose model was altered.

---

## 10. Rollback

Three levels, cheapest first.

**Per module, no deploy** — the flag is read per call:

```bash
wrangler secret delete DATA_SOURCE_USERS --env <environment>
# or set it to anything other than the literal string "d1"
```

Users return to MongoDB; departments are unaffected, and vice versa.

**Revert the module** — the Mongo implementation is a separate file and was not edited beyond
narrowing two signatures:

```bash
git checkout -- src/server/repositories src/server/permissions/visibility.ts \
  src/server/services/{user,department,dev-switcher}.service.ts tests
rm -f src/server/db/d1-context.ts tests/helpers/test-d1.ts \
      tests/d1/user-department-repository.test.ts
npm run typecheck && npm test
```

**Nothing to roll back in the data.** No D1 write path is reachable while both flags are unset,
and MongoDB was neither read differently nor written differently by this module.

---

## 11. Carried forward

| Item | Phase |
|---|---|
| Do any real `departments.created_by` values point at missing users? (§6.2) | 5 — relationship validation |
| `users.projectIds[]` vs `projects.memberUserIds[]` disagreement report | 5 |
| `dataSourceSummary()` is exported but not yet surfaced anywhere | 6 — admin migration report |
| Durable Object rate limiter | 3 — before the Worker serves authenticated traffic |
| `resourceVisibilityFilter` and friends still MongoDB-shaped | 3, module 4 |

---

## 12. Acceptance criteria

- [x] API response shapes remain stable — asserted by the parity block, field by field,
      including `Date` types
- [x] Existing frontend hooks continue working — no route, DTO, hook or component changed
- [x] Backend permission validation remains active — every service kept its permission checks;
      the tenant predicate became a required argument rather than an optional filter key
- [x] Module tests pass before moving to the next module
- [x] No raw SQL in a UI component or an API route — SQL exists only in `*.repository.d1.ts`
- [x] `API route → service → permission check → repository → D1` preserved

---

## 13. Next

**Module 2 — roles and permissions.** It is the natural next step: `role.repository.ts` is
what `decorate()` in `user.service.ts` already calls for every user summary, so users and roles
are the pair most likely to expose a cross-module inconsistency while both are half-migrated.
