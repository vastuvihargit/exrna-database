# The `DATA_SOURCE_*` flag matrix

Source of truth: `src/server/repositories/data-source.ts`. This document explains that file. If
the two disagree, the code wins, and this document is wrong.

## 1. How a flag works

* `DATA_SOURCE_<MODULE>=d1` routes that module's repository to D1. **Unset, or any other value,
  means MongoDB.** The safe default is "absent".
* The flag is read **per call**, not cached at startup. Changing it takes effect on the next
  request.
* Ids are preserved across both databases (`21-phase-9-mongo-to-d1-migration.md`), so a record
  created on one engine is addressable on the other once the migration has copied it. It is
  *not* visible there until then.

## 2. Every flag

| Flag | Module | Must also be on D1 (foreign keys, transitive) | Must move with (same engine, both directions) |
|---|---|---|---|
| `DATA_SOURCE_ORGANIZATIONS` | organizations | — | — |
| `DATA_SOURCE_USERS` | users, auth providers | organizations | — |
| `DATA_SOURCE_DEPARTMENTS` | departments | organizations | — |
| `DATA_SOURCE_ROLES` | roles, role permissions, user roles | organizations, users | — |
| `DATA_SOURCE_PROJECTS` | projects, members | organizations, users, departments | — |
| `DATA_SOURCE_EXPERIMENTS` | experiments, samples, collaborators | + projects | — |
| `DATA_SOURCE_FOLDERS` | folders, ancestors, folder ACLs | organizations, users, departments | **files** |
| `DATA_SOURCE_FILES` | files, metadata, tags, FTS, file ACLs | + folders | **folders, fileVersions, reviews** |
| `DATA_SOURCE_FILE_VERSIONS` | file versions | + files | **files, reviews** |
| `DATA_SOURCE_SEARCH` | stars, recent items, saved searches | organizations, users | — |
| `DATA_SOURCE_REVIEWS` | reviews, reviewers, approvals | + files, fileVersions | **files, fileVersions** |
| `DATA_SOURCE_AUDIT_LOGS` | audit trail (append-only) | organizations, users | — |
| `DATA_SOURCE_INVENTORY` | items, batches, stock ledger | organizations, users, departments, projects, experiments, files | — |
| `DATA_SOURCE_NOTIFICATIONS` | notifications | organizations, users | — |
| `DATA_SOURCE_SESSIONS` | sessions | organizations, users | — |
| `DATA_SOURCE_LOGIN_HISTORY` | login history | users, sessions | — |
| `DATA_SOURCE_STORAGE_USAGE` | quota counters | users, departments, projects, files, fileVersions | — |
| `DATA_SOURCE_ACTIVITIES` | activity feed | organizations, users, folders, projects | — |
| `DATA_SOURCE_COMMENTS` | comments, mentions | organizations, users, files, fileVersions | — |
| `DATA_SOURCE_DRIVE_SYNC` | Drive change-feed cursor | — | — |
| `DATA_SOURCE_UPLOAD_SESSIONS` | in-flight uploads | organizations, users, folders, files, fileVersions | — |
| `DATA_SOURCE_APP_SETTINGS` | settings | organizations | — |

("+ x" means "everything the row above needs, plus x".)

Twenty-two flags, and every one is read by a repository façade: setting it changes which database
serves that module. `tests/unit/data-source-matrix.test.ts` fails if a flag is added that no repository
reads.

### 2.1 Removed: `DATA_SOURCE_COLLABORATION` and `DATA_SOURCE_JOBS`

Both were listed from the start of Phase 3, "so the flag surface is fixed before the modules
land", and both turned out to name nothing:

* **Collaboration** — every table in `schema/collaboration.ts` already has its own flag:
  comments (`COMMENTS`), reviews and approvals (`REVIEWS`), notifications (`NOTIFICATIONS`).
* **Jobs** — the remaining tables in `schema/jobs.ts` belong to the Personal-Drive import and the
  local-disk → Drive storage migration. Those tools read the local filesystem by definition, run
  on Node only, and have no D1 repository (on a Worker their routes answer
  `501 NODE_ONLY_OPERATION`). Upload sessions and the Drive cursor, the two job-like tables a
  Worker does use, have their own flags.

No code read either variable. A production switch that does nothing is worse than none: an
operator would "flip" it at cutover and believe something had moved. They were removed from the
matrix, from `workerReadinessGaps()`, and from the runbooks. A leftover
`DATA_SOURCE_COLLABORATION` / `DATA_SOURCE_JOBS` in an environment is simply ignored.

## 3. Unsafe combinations fail closed, at startup

`assertDataSourceMatrix()` runs inside `loadEnv()` (Node) and `loadWorkerEnv()` (Worker, from
`cloudflare-worker.ts`). It **refuses to start** and names every offending pair at once, in two
cases:

1. **Foreign-key split.** A module is on D1 while something it references is still on MongoDB.
   Every write would fail on a constraint. Example: `SESSIONS=d1` with `USERS` unset.
2. **Move-together split** (`DATA_SOURCE_MOVE_TOGETHER`, new in this pass). The drive core's
   multi-table writes are single D1 batches, and the engines refuse to run half of one on each
   database:
   * `FOLDERS` with `FILES`: folder move, trash, restore and archive rewrite both;
   * `FILES` with `FILE_VERSIONS`: an upload writes the version and the file together;
   * `REVIEWS` with `FILES` and `FILE_VERSIONS`: a review decision updates all three.

   Before this pass these splits booted cleanly and failed on the user's action
   (`SplitDataSource*Error`). They now fail at startup.

`workerReadinessGaps()` lists every module not on D1. In a **production Worker** that is a
startup error; elsewhere it is a warning, so a partial preview can still boot.

## 4. Safe configurations

| Configuration | Where | Notes |
|---|---|---|
| **All unset** | Node production today | MongoDB serves everything. This is the rollback state. |
| **All `d1`** | every Worker; Node only for rehearsal and E2E | The only configuration a production Worker accepts |
| Any prefix that satisfies §2 | Node, during a soak test | Legal but **not recommended for production**: records written on one engine are invisible on the other until the migration copies them |

There is **no supported partial production cutover.** The Worker needs everything on D1. The
Node deployment can run a partial set, but it would then be writing to two databases that no
process keeps in sync. Cutover is all flags, at once, inside the write freeze
(`CUTOVER-RUNBOOK.md`).

## 5. Flags with side effects when they flip

| Flag | What happens at the flip | Handling |
|---|---|---|
| `DATA_SOURCE_SESSIONS` | **Everyone is logged out.** D1 holds only the sessions the migration copied, and on a Worker, Access-bridge sessions are re-issued on the next page load anyway. | Flip inside the maintenance window. Users sign in again through Cloudflare Access. |
| `DATA_SOURCE_NOTIFICATIONS` | Notifications written on MongoDB after the last migration pass never appear | The final delta pass runs after writes stop, so nothing is written in between |
| `DATA_SOURCE_UPLOAD_SESSIONS` | Uploads in flight at the flip are lost (by design, `upload_sessions` is not migrated) | `read_only` mode first; wait for in-flight uploads to finish or expire |
| `DATA_SOURCE_DRIVE_SYNC` | The Drive cursor continues from the migrated value | Stop the Node `drive:sync` cron before the final pass, so the cursor is not advanced on MongoDB after it was copied |

## 6. Reverting

Deleting a flag returns that module to MongoDB on the next request. **That is only a data-safe
revert before anything has been written to D1.** After cutover, see `ROLLBACK-RUNBOOK.md`: D1-only
writes do not exist in MongoDB, and a flag revert alone would make them disappear from view.
