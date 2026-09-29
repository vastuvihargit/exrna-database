# Cloudflare Migration — Phase 3, Module 3: Projects and Experiments

**Status:** complete. MongoDB remains the live database. No UI file changed.
**Predecessors:** [`03-…module-1-users-departments.md`](./03-phase-3-module-1-users-departments.md) · [`04-…module-2-roles-permissions.md`](./04-phase-3-module-2-roles-permissions.md)

---

## 1. What this module produced

```
src/server/repositories/
  project.repository.{contract,mongo,d1}.ts      + façade
  experiment.repository.{contract,mongo,d1}.ts   + façade
tests/d1/project-experiment-repository.test.ts   58 tests, both engines
```

`DATA_SOURCE_PROJECTS` and `DATA_SOURCE_EXPERIMENTS` are unset. Nothing changed for the
running system.

---

## 2. The last `ClientSession` above the repository line is gone

`project.service.ts` wrapped `create` and `updateById` in `withTransaction` and passed the
session down, alongside a separate `syncMembership` call — because a project row and its
membership must land together.

D1 has no interactive transaction, so a session cannot cross the repository boundary.
Membership and tags are now **fields on the write**, and each implementation delivers the
atomicity its own way:

| | Mongo | D1 |
|---|---|---|
| `create` | session opened *inside* the repository | `db.batch()` |
| `updateById` | same | same |

`syncMembership` is gone from the public surface. It existed only to keep MongoDB's two copies
of membership in step; in D1 there is one copy and writing membership *is* writing
`project_members`.

This is the first of the 25 `withTransaction` sites Phase 2 carried forward, and it removed
the `withTransaction` import from `project.service.ts` entirely.

---

## 3. The sharpest asymmetry in the codebase so far

**`experiment.model.ts` applies `applySoftDeleteFilter`. `project.model.ts` does not.**

So in MongoDB, today: a trashed experiment vanishes from every read, and a trashed project
stays visible with `status: 'archived'`. Same module, opposite rules.

Both are reproduced exactly — `experiments` gets an explicit `deleted_at IS NULL` on every
read and on `updateById`; `projects` gets none — and a parity test asserts the asymmetry
holds identically in both databases. The temptation to make these consistent is precisely what
would change what a user sees.

---

## 4. Membership: the Phase 2 data-model change, finally exercised

MongoDB stores project membership twice (`projects.memberUserIds[]` and `users.projectIds[]`).
D1 stores it once, in `project_members`. `ProjectRecord.memberUserIds` is a column read in one
database and a join in the other, and a parity test asserts nothing above the repository can
tell — on create, and again after a membership replacement.

`listVisible`'s "projects I am a member of" branch is a **subquery**, not a join: joining a
membership table multiplies rows, and the `DISTINCT` needed to undo that is a sort the query
does not otherwise need.

One guard worth naming: when an actor has no route to any project — no user id, no department,
no scope grants — `listVisible` returns `[]`. The absence of branches must mean "nothing", never
"the whole organization". Asserted in both engines.

**Later correction (2026-09-29, found by the browser suite):** as written here, and in the
MongoDB original it was ported from, every role-scope branch ignored the project's
classification, so a department grant revealed the department's `confidential` projects to
someone cleared only to `internal`. `VisibleProjectsInput` now carries `clearance`; the
company-wide, own-department and scope branches require `confidentiality ∈ clearance`, and the
member/lead branches do not. `getProjectRoot` applies the same gate through `canSeeProject`
(`permissions/project-visibility.ts`). See `25-browser-e2e.md` §5.

---

## 5. A hazard the migration introduces: FTS5 query syntax

**MongoDB's `$text` takes a raw user string. FTS5's `MATCH` does not.**

FTS5 has a query language: `-` is NOT, `*` is a prefix wildcard, `:` filters a column, `NEAR`
and `OR` are operators, and an unbalanced quote is a syntax error. So a search for a sample id
like `S-4471` does not return nothing — **it throws**, turning the search box into a 500. This
was found by a test that expected zero results and got an exception.

`toFtsQuery()` extracts word tokens and re-quotes each as a literal phrase, which makes every
metacharacter inert, then joins them with `OR` — because that is what `$text` does with
space-separated terms, and FTS5 would otherwise default to `AND` and quietly return far fewer
results than the Mongo path for the same query. Capped at 32 tokens.

A term with nothing searchable in it (`***`) returns **no results**, not all results: dropping
the filter would turn a nonsense query into a full listing.

Eight adversarial inputs are asserted, plus the OR-semantics case.

**Module 6 (search) must reuse this.** Every FTS-backed repository has the same hazard.

---

## 6. A Phase 2 defect found: `bm25()` weights were shifted by one

`bm25()` takes one weight **per column of the FTS table, including the UNINDEXED one**.

Migration 0001 documented, and `schema-contract.test.ts` used:

```sql
ORDER BY bm25(files_fts, 10.0, 6.0, 5.0, 1.0)   -- 4 weights, 5 columns
```

`files_fts` is `(file_id UNINDEXED, display_name, original_filename, keywords, description)`.
So 10.0 landed on `file_id` — a column that can never match — `display_name` got 6.0,
`keywords` got 1.0, and `description` fell through to the 1.0 default. The intended
10/6/5/1 ranking is not merely wrong, it is **gone**.

Demonstrated on a real FTS5 table: two documents matching in differently-weighted columns
score **identically** (−2.86 both) with the shifted form, and correctly (−4.36 vs −2.86) with
the placeholder included.

**Nothing was mis-ranked in a running system** — no production code used it; the file
repository arrives in module 4. What existed was a wrong convention waiting to be copied.

Fixed: the comment in 0001 now documents the correct form for both tables, and
`experiment.repository.d1.ts` uses `bm25(experiments_fts, 0.0, 10.0, 8.0, 6.0, 1.0)` with a
test that fails if the weights shift.

### 6.1 A test that was not testing what its name said

`schema-contract.test.ts` had *"finds a file by name and ranks it with the Mongo weights"*.
It asserted `.toContain(FILE)` against a **one-document** fixture — any ordering passes. The
weights in its query were also the shifted ones.

Renamed to *"finds a file by name through the trigger-maintained index"*, which is what it
does. Real ranking is asserted in this module's suite against a corpus where the order can
actually differ; the files_fts equivalent belongs with the file repository in module 4.

This is the second instance of the pattern Phase 2 recorded in its own §8.2 — a green test
that checked less than its name claimed.

---

## 7. The FTS re-index runs after the batch, not inside it

Two reasons, and the second is the one that matters:

1. `db.run(sql…)` is not a valid `batch()` item.
2. Even if it were, it would be wrong. The batch contains the base-row `UPDATE`, which fires
   `trg_experiments_fts_update`, which re-aggregates `experiment_samples` — and at that point
   the new sample rows have not been written yet. The index would be rebuilt from the samples
   the experiment *used to* have.

The batch guarantees the data; the re-index runs immediately after. If it fails, search is
stale while the records are correct — the right way round, and the state Phase 4's `SYNC_QUEUE`
consumer exists to repair.

It is also what makes a new experiment findable by sample id at all:
`trg_experiments_fts_insert` writes `samples` as `''`, because sample rows are written after
the parent. There is a test.

---

## 8. Files

**Added (9):** `project.repository.{contract,mongo,d1}.ts`,
`experiment.repository.{contract,mongo,d1}.ts`,
`tests/d1/project-experiment-repository.test.ts`, this document.

**Modified (6):**

| File | Change |
|---|---|
| `project.repository.ts` / `experiment.repository.ts` | now façades |
| `services/project.service.ts` | `withTransaction` removed (2 sites); patch instead of `$set`; import dropped |
| `services/experiment.service.ts` | typed patch instead of `$set` |
| `services/drive.service.ts` | one `$set` call site |
| `drizzle/migrations/0001_…sql` | bm25 weight comment corrected — §6 |
| `tests/d1/schema-contract.test.ts` | test renamed to what it asserts — §6.1 |

**Not modified:** every component, page, hook, DTO and API route.

---

## 9. Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ 1 pre-existing warning, unchanged from baseline |
| `tests/d1/project-experiment-repository.test.ts` | ✅ **58/58** |
| `npm run test:d1` (4 files) | ✅ **181/181** |
| `npm test` (full Mongo suite) | ✅ **680/680**, 46 files — unchanged from baseline |
| `npm run build` (Node) | ✅ `.next/standalone` present |
| `npm run cf:build` | ✅ server bundle 11.53 MB |

**Total: 861 tests passing across both configs.**

---

## 10. Schema changes

**None.** No migration added; 0001 changed only in a comment.

---

## 11. Rollback

```bash
# Per module, no deploy:
wrangler secret delete DATA_SOURCE_PROJECTS --env <environment>
wrangler secret delete DATA_SOURCE_EXPERIMENTS --env <environment>
```

```bash
# The module:
git checkout -- src/server/repositories src/server/services drizzle tests
rm -f src/server/repositories/{project,experiment}.repository.{contract,mongo,d1}.ts \
      tests/d1/project-experiment-repository.test.ts
npm run typecheck && npm test
```

Note that reverting `project.service.ts` restores the `withTransaction` blocks, which the
current repository signatures no longer accept — the two are coupled, and the build failing is
the correct signal.

---

## 12. Carried forward

| Item | Phase |
|---|---|
| `toFtsQuery()` must be reused by every FTS-backed repository | 3, module 6 |
| files_fts ranking test with a real corpus | 3, module 4 |
| Migration 0003 — CHECK constraint for the role scope-shape invariant | your call |
| 23 remaining `withTransaction` sites | 3, remaining modules |
| `users.projectIds[]` vs `projects.memberUserIds[]` disagreement report | 5 |

---

## 13. Acceptance criteria

- [x] API response shapes remain stable — parity block compares `ProjectRecord` and
      `ExperimentRecord` field for field, including `Date` types
- [x] Existing frontend hooks continue working — no route, DTO, hook or component changed
- [x] Backend permission validation remains active — `listVisible` returns `[]` rather than an
      unfiltered listing when an actor has no route; an empty visible-project set means nothing
- [x] Module tests pass before moving to the next module
- [x] No raw SQL in a UI component or an API route
- [x] `API route → service → permission check → repository → D1` preserved

---

## 14. Next

**Module 4 — folders and files.** The largest module: `resource_permissions` (the ACL that
`resourceVisibilityFilter` matches into), `folder_ancestors`, `file_folder_ancestors`,
`file_metadata`, and the Google Drive file ids that must survive exactly. It is also where
`resourceVisibilityFilter` finally stops being MongoDB-shaped.
