# Cloudflare Migration — Phase 2: D1 Schema

**Status:** complete. No repository, service, route or UI file changed. MongoDB untouched.
**Predecessors:** [`00-phase-0-analysis.md`](./00-phase-0-analysis.md) · [`01-phase-1-worker.md`](./01-phase-1-worker.md)

---

## 1. What this phase produced

**54 tables**, 171 indexes (46 unique, 15 partial), 160 foreign-key clauses, 4 CHECK
constraints, 3 FTS5 virtual tables and 13 triggers — generated from Drizzle definitions and
applied to a real D1 database.

```
src/server/db/schema/          9 files, ~1,900 lines of table definitions
drizzle/migrations/
  0000_initial_schema.sql      generated — 54 tables, all indexes and FKs
  0001_fts_triggers_and_seed.sql  hand-written — FTS5, immutability, permission catalogue
src/server/db/d1.ts            connection + the withTransaction replacements
drizzle.config.ts
tests/d1/schema-contract.test.ts
```

Every one of the 32 MongoDB collections has a mapping. Nothing was dropped.

---

## 2. Conventions, and why each one is forced

| Convention | Choice | Reason |
|---|---|---|
| Primary keys | `TEXT` holding the existing 24-char ObjectId hex | Identity is the same in both databases, so verification compares directly rather than through a mapping table; every id already in an audit row, a notification or a bookmarked URL keeps resolving. ObjectId hex also sorts monotonically, which is what makes `WHERE id > :last_id` a stable Phase 5 resume cursor. |
| Timestamps | `TEXT` ISO-8601 UTC | Sorts lexicographically in chronological order, so `ORDER BY` and range predicates need no conversion — and a row read during an incident is legible, unlike an epoch integer. Millisecond precision preserved for the audit log. |
| Booleans | `INTEGER` 0/1 | SQLite has no boolean type. |
| `Mixed` fields | `TEXT` JSON | Only where the value is read whole and never queried into. Anything filtered, joined or indexed became a child table. |

Post-cutover rows will use `crypto.randomUUID()` (36 chars). Both shapes coexist in the same
column deliberately — the alternative is minting fake ObjectIds forever, which would make
"was this row migrated or created?" unanswerable.

---

## 3. Embedded arrays that became tables

Eighteen. Each is a table because something *queries into it*; JSON would have turned an
indexed lookup into a scan.

| Was | Now | The query that forced it |
|---|---|---|
| `folders.permissions[]`, `files.permissions[]` | `resource_permissions` | `resourceVisibilityFilter()` matches `principalId` inside the drive listing |
| `folders.pathAncestors[]` | `folder_ancestors` | subtree ops, breadcrumbs, circular-move checks |
| `files.folderPathAncestors[]` | `file_folder_ancestors` | "everything under this folder" |
| `reviews.decisions[]` | **`approvals`** | "every approval this person signed in Q3"; `requiredApprovals` becomes `COUNT(*)` |
| `inventoryItems.batches[]` | `inventory_batches` | atomic conditional decrement — see §5 |
| `projects.memberUserIds[]` + `users.projectIds[]` | **`project_members`** (one table) | see §4 |
| `experiments.sampleIds[]` | `experiment_samples` | "which experiment did sample S-4471 come from?" |
| `files.metadata` | `file_metadata` | `sampleId` / `experimentCode` are searched and filtered |
| `roles.permissions[]` | `role_permissions` + `permissions` | FK catches a typo'd permission at insert |
| `comments.mentionedUserIds[]` | `comment_mentions` | "mentions of me" |
| `files/projects/experiments.tags[]` | `resource_tags` | faceted search |
| …plus `user_auth_providers`, `role_scope_types`, `review_reviewers`, `experiment_collaborators`, `activity_folders`, `inventory_item_documents`, `stock_transaction_documents` | | |

Three tables are polymorphic (`resource_permissions`, `resource_tags`, `user_roles.scope_id`)
and therefore cannot carry a foreign key on the target — SQL has no polymorphic reference.
That is a real, accepted loss of a constraint, and Phase 5's relationship validation checks
every such row resolves.

---

## 4. One deliberate data-model change

**`users.projectIds[]` is not reproduced.** MongoDB stored project membership twice and kept
the copies in step from the service layer. Two copies of one fact are two things that can
disagree, and the disagreement is invisible until somebody cannot see a project they belong
to. `project_members` is the single source in D1.

The Phase 5 migration loads the **union** of both arrays and **reports any row present in one
and not the other** — because a disagreement there is a real access-control defect that the
duplication has been hiding.

This is the only place the schema deviates from a faithful reproduction. Everything else,
including the denormalized counters and the denormalized `authorName`/`itemCode` labels, is
preserved exactly.

---

## 5. Where normalization changed a guarantee, and how it was re-established

MongoDB embedded `batches[]` inside the inventory item so the availability check and the
decrement were **one atomic `findOneAndUpdate`** with a `quantity: { $gte: n }` filter. There
was no read-then-write window in which two requests could both believe there was enough.

Splitting batches into their own table loses that for free. It is re-established by the same
mechanism, moved into SQL:

```sql
UPDATE inventory_batches
   SET quantity = quantity - ?
 WHERE id = ? AND quantity >= ?;
```

Two concurrent issues serialize; the second sees the decremented value; exactly one reports
`changes() = 1`. **Negative stock is prevented by the WHERE clause, not by a transaction.**
`CHECK (quantity >= 0)` is the belt to that braces, so even a hand-written statement during an
incident cannot drive a batch negative. Both are asserted by tests (§8).

---

## 6. What Drizzle could not express — migration 0001

### 6.1 Full-text search

MongoDB gave each collection one weighted `$text` index and sorted by `$meta: 'textScore'`.
The equivalent is FTS5 with `bm25()`, whose weights are supplied at query time:

| Table | Columns | Weights (reproducing the Mongo ranking) |
|---|---|---|
| `files_fts` | display_name, original_filename, keywords, description | 10, 6, 5, 1 |
| `folders_fts` | name, description | — |
| `experiments_fts` | code, title, samples, objective | 10, 8, 6, 1 |

**Standalone tables, not `content=` external-content tables.** External content ties an FTS
row to one base table, and a file's searchable text is spread across three (`files`,
`file_metadata`, `resource_tags`).

`file_id` / `folder_id` / `experiment_id` are `UNINDEXED`. If they were not, pasting an id
into the search box would surface the record regardless of whether the searcher may see it.
There is a test for exactly that.

Triggers maintain the base-table columns automatically, so a rename or a trash is reflected
immediately. **A trashed row is removed from the index rather than filtered at query time** —
an index that cannot produce a trashed file is a stronger guarantee than a WHERE clause
somebody has to remember. The columns sourced from `file_metadata` and `resource_tags` are
written by an explicit re-index statement rather than by triggers on those tables, because a
per-row trigger there would re-aggregate every tag on every single-tag edit. Phase 3's
repository and Phase 4's `SYNC_QUEUE` consumer call the same statement.

### 6.2 Immutability

Mongoose enforced the append-only audit log and stock ledger with pre-hooks. SQL has no hook,
so migration 0001 adds four `RAISE(ABORT)` triggers. Without them, immutability would be a
property of the code that happens to be calling rather than of the data.

**No equivalent trigger was added to `approvals`**, deliberately. MongoDB enforced that
table's append-only nature by service discipline rather than by a hook — decisions were an
embedded array inside an updatable document — and adding a hard constraint would tighten a
rule the application has never been tested against.

### 6.3 Permission catalogue

28 rows seeded from `domain/permissions.ts`, which stays the source of truth. The table exists
so `role_permissions.permission_key` can carry a foreign key: a typo'd permission then fails
at insert instead of silently granting nothing. A test asserts the seed and the TypeScript
constant have not drifted.

---

## 7. Partial indexes — the ones that carry a guarantee

Fifteen partial indexes were generated. Five reproduce a Mongo `partialFilterExpression` that
was doing real work:

| Index | Condition | What it prevents |
|---|---|---|
| `ux_file_versions_drive_id` | `google_drive_file_id IS NOT NULL` | **A retried transfer recording a second Drive file for one version.** Enforced at the database, not in the worker — which is the layer that is by definition unavailable when the worker has just crashed. |
| `ux_folders_drive_id` | `google_drive_folder_id IS NOT NULL` | Two concurrent uploads into one new folder creating two Drive folders |
| `ux_reviews_open_per_version` | `status = 'pending'` | Two reviewers approving the same bytes through different requests |
| `ux_user_roles_active` | `revoked_at IS NULL` | A role being ungrantable after revocation, while still forbidding duplicate live grants |
| `ux_storage_migration_items_claim` | `claim_active = 1` | Two workers transferring the same version at once |

The partiality is the point in every case: a plain unique index would break the normal path
(many un-migrated versions all have `NULL`, and every one after the first would be unwritable).

---

## 8. Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ 1 pre-existing warning, unchanged from baseline |
| `wrangler d1 migrations apply … --local` (fresh DB) | ✅ 226 + 18 = **244 statements**, both files ✅ |
| `tests/d1/schema-contract.test.ts` | ✅ **12/12** against real D1, 54 s |
| `npm test` (full suite) | see §8.2 |
| `npm run build` / `npm run cf:build` | ✅ both succeed |

### 8.1 What the contract tests actually assert

Against a **real local D1** through `wrangler d1 execute` — not an in-process SQLite
stand-in, because every assertion here is a claim about what the engine does, and a
differently-compiled SQLite could satisfy the test and not the deployment.

- a MongoDB ObjectId is stored byte-for-byte
- a second version claiming the same Drive file id is **rejected**
- many un-migrated versions (`NULL` drive id) still insert — proving the index is partial
- a second folder claiming the same Drive folder id is **rejected**
- audit log `UPDATE` and `DELETE` are **rejected** with the append-only message, and the row
  is verified unchanged afterwards
- stock transaction `UPDATE` and `DELETE` are **rejected**
- an overdrawing conditional decrement leaves the batch untouched; a legitimate one applies
- a hand-written negative quantity is **rejected** by the CHECK constraint
- FTS finds a file by name and ranks with the Mongo weights
- FTS does **not** match a file by its id
- the seeded catalogue equals `PERMISSIONS` exactly
- a typo'd permission key is **rejected** by the foreign key

### 8.2 A test bug worth recording

The first version of `schema-contract.test.ts` reported **12/12 passing in 4.3 seconds**. It
was asserting nothing.

`execFileSync('npx', [...], { shell: true })` on Windows re-splits arguments, so
`--command "SELECT 1 AS x"` arrived as three unknown arguments and every call failed. The
`beforeAll` caught that, set `available = false`, and each test began `if (!available) return;`
— the pattern the existing Mongo suites use. Twelve green ticks, zero assertions.

Two changes, both of which matter more than the bug:

1. Wrangler is now invoked as `execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', …])`
   — no shell, no re-splitting.
2. **The skip guard is gone.** The suite now throws with an actionable message if it cannot
   reach D1. `vitest.config.ts` already records the project's position on this: silently
   skipping "is a far worse outcome than a slower run". These are the schema's security
   guarantees; a run that quietly does not check them is indistinguishable from one that does.

The corrected suite takes 54 s and does 30 real round trips. CI now applies migrations before
`npm test` so the suite has a database to fail against.

---

## 9. Schema changes

This phase **is** the schema change. No MongoDB model, index or document was altered — the
Mongo schema files are read by the Drizzle definitions only to import their enum constants, so
the two vocabularies cannot drift.

Full collection → table mapping: `00-phase-0-analysis.md` §3.

---

## 10. Files

**Added (14):** `drizzle.config.ts`, `drizzle/migrations/{0000,0001}*.sql`,
`drizzle/migrations/meta/*`, `src/server/db/schema/{_shared,identity,access,research,drive,collaboration,inventory,audit,jobs,index}.ts`,
`src/server/db/d1.ts`, `tests/d1/schema-contract.test.ts`, this document.

**Modified (3):** `package.json` (drizzle-orm, drizzle-kit, `db:*` and `test:d1` scripts),
`.github/workflows/ci.yml` (apply migrations before tests), `.gitignore` (unchanged from
Phase 1 — `.wrangler/` already covered).

**Not modified:** every repository, service, route, component, hook, and
`src/server/db/models/**`. `connection.ts` still holds the MongoDB connection; `d1.ts` sits
beside it.

---

## 11. Acceptance criteria

- [x] Every MongoDB collection has a clear D1 mapping — 32 collections → 54 tables
- [x] Relationships use explicit foreign keys — 160 FK clauses; the three polymorphic
      columns are named and validated in Phase 5 instead
- [x] Required indexes exist — 171, including all 5 guarantee-carrying partial unique indexes
- [x] Migration files run successfully — 244 statements against real D1, from a clean database
- [x] Existing IDs can be preserved — asserted by test
- [x] Partial unique indexes proven by an inserting test *(Phase 0 addition)*
- [x] No file binaries or extracted content in D1

---

## 12. Rollback

Nothing to roll back: no production system reads D1, and MongoDB is untouched.

```bash
# Drop the local database
rm -rf .wrangler/state/v3/d1

# Remove the phase entirely
git checkout -- package.json package-lock.json .github/workflows/ci.yml
rm -rf drizzle src/server/db/schema src/server/db/d1.ts tests/d1 drizzle.config.ts
npm ci && npm run typecheck && npm test
```

Nothing has been applied to a remote D1. `drizzle.config.ts` deliberately uses
`dialect: 'sqlite'` rather than `d1-http`, so drizzle-kit **cannot** push to a remote database
— a migration reaches staging or production only through `wrangler` and a reviewed SQL file.

---

## 13. Carried forward

| Item | Phase |
|---|---|
| `users.projectIds[]` vs `projects.memberUserIds[]` disagreement report | 5 |
| Polymorphic column validation (`resource_permissions`, `resource_tags`, `user_roles.scope_id`) | 5 |
| FTS re-index statement for metadata/tag columns | 3 (repository), 4 (queue consumer) |
| Applying the 25 `withTransaction` sites to `withBatch` / `withOptimisticRetry` | 3 |
| Session and login-history cleanup job (replacing the Mongo TTL indexes) | 4 |
| `MIGRATION_WORKFLOW` binding | 5 |

Two Mongo TTL indexes have **no D1 equivalent** and are now the application's responsibility:
`sessions.absoluteExpiresAt` and `loginHistory.createdAt` (400 days). Both have a supporting
index; neither has a sweeper yet. This is a real behavioural difference, recorded here so it
is not discovered later as unexplained table growth.

---

## 14. Next

**Phase 3** — repository migration, 11 sub-phases, one module at a time behind a
per-module `DATA_SOURCE` flag. It needs Phase 1 and Phase 2, both of which are now done.

**Phase 1a** (Drive storage cutover) remains independent, remains the long pole, and still
gates Phase 7.
