# Phase 3, module 7 — atomic folder + file moves on D1

Closes the last consistency window in the drive hierarchy: a folder move now commits the folder
tree and every contained file's ancestor chain in **one D1 batch**, or commits nothing.

---

## 1. What was wrong

`folder.service.ts` did this inside `withTransaction`:

```text
folderRepository.moveSubtree(...)      // D1 batch 1 commits
fileRepository.reparentSubtree(...)    // D1 batch 2 commits
folderRepository.adjustChildFolderCount(old, -1)
folderRepository.adjustChildFolderCount(new, +1)
```

On MongoDB the session made those four one unit. On D1 it made them nothing of the kind:
`withTransaction` opens a **Mongo** session, which governs no D1 statement. So a crash, a
timeout, a thrown error or a Worker eviction between batch 1 and batch 2 left the folders moved
and every file in the subtree still carrying its old ancestor chain.

**That state is not cosmetic and it is not self-announcing.** Reads by id keep working. What
breaks is everything that goes through the closure table — subtree search, "everything under
this project", and `inheritedGrant` / `inheritedDenyGuard`, which decide *visibility*. A file
whose `file_folder_ancestors` rows still name the old parent inherits **the old parent's ACL**.
The failure mode is a file that stays visible to whoever could see where it used to live, with
nothing in the UI to suggest anything went wrong.

---

## 2. The atomicity boundary

`src/server/db/d1-unit-of-work.ts` → `moveFolderSubtreeWithFiles()`.

```text
read everything            the moved folder, destination, subtree, current chains
compute the new shape      in memory, folders *and* files
build every statement      from both repositories' builders; nothing executed
one db.batch()             all commit or none do
verify, retry on no-op     the guard failed; somebody else got there first
```

Nothing in the module executes a statement of its own, and nothing reads hierarchy state that
the batch itself rewrites.

The unit-of-work is **not** an authorization boundary. The service authorises source and
destination before calling it, exactly as before. What it re-checks is *structural* — circular
moves, cross-tenant moves, a destination deleted since — because those corrupt the closure table
in ways no later read reports as an error.

### The batch, in order

| # | Statements | Guarded |
|---|---|---|
| 1 | descendant `folders` rows (depth shift, drive type, department, project) | yes |
| 2 | `folder_ancestors`: drop old prefix, shift remainder, prepend new prefix | yes |
| 3 | moved folder's own `folder_ancestors` chain, replaced outright | yes |
| 4 | `files` rows in the subtree (drive type, department, project) | yes |
| 5 | `file_folder_ancestors`, rebuilt per folder | yes |
| 6 | both `child_folder_count` adjustments | no |
| 7 | the moved folder's own row — **invalidates the guard, so it is last** | — |

Steps 1–5 all carry the same predicate: *"`folders.updated_at` for the moved folder is still the
value I planned against."* Step 7 is the only statement that changes it. So either the whole
batch applies to the state it was computed from, or a concurrent writer got there first and
**every guarded statement matches nothing** — a clean no-op the caller detects and retries.
There is no arrangement in which the folders move and the files do not.

---

## 3. Why the file plan is computed in memory

`reparentSubtree` used to read `folder_ancestors` to discover each file's new chain. That worked
because the folder move had *already committed* — batch 1 was done.

Inside one batch it cannot: the folder statements are built but unexecuted, so `folder_ancestors`
still holds the old shape. Reading it there would plan every file against the pre-move tree.

So the module computes the new chains itself. A move re-roots a subtree without rearranging it,
so each descendant's new chain is *destination chain + moved folder + whatever already sat
between the moved folder and that descendant* — and that suffix comes from the **current**
`folder_ancestors`, which is correct precisely because it has not been rewritten yet.

The split is expressed in the file repository as two functions, so there is one implementation
with two sources of input:

```text
planFileReparent(db, input)              reads folder_ancestors  → standalone path
                                         computed in memory      → unit-of-work path
                    ↓
buildFileReparentStatements(db, {...,  folderChains, guard })
```

---

## 4. Statement builders

| Function | Module | Returns |
|---|---|---|
| `assertMoveIsStructurallyLegal` | folder d1 | — (throws) |
| `planFolderMove` | folder d1 | `FolderMovePlan` — old/new depth, shift, `updated_at` stamp |
| `moveGuard(folderId, stamp)` | folder d1 | the `SQL` predicate both halves share |
| `buildFolderMoveStatements` | folder d1 | guarded folder + `folder_ancestors` statements |
| `buildFolderMoveCommitStatement` | folder d1 | the moved folder's row — must be last |
| `buildChildFolderCountStatement` | folder d1 | one counter adjustment |
| `moveDidApply` | folder d1 | did the guard hold? |
| `planFileReparent` | file d1 | `FolderChain[]` from the database |
| `buildFileReparentStatements` | file d1 | guarded `files` + `file_folder_ancestors` statements |

`moveSubtree()` and `reparentSubtree()` still exist and now call these same builders, so the
logic is not duplicated. `moveSubtree` remains correct for a folders-only move; the composed path
is what the service uses.

---

## 5. Optimistic concurrency

Unchanged in mechanism, extended in reach: the `updated_at` stamp guard that already protected
the folder half now protects the **file** half too. A stale plan writes nothing on either side.

Three tests pin this: a rename between planning and execution makes the whole composed batch a
no-op; the same with file statements alone proves the guard is genuinely on them and not only on
the folder statements; and an uncontended move still succeeds through the retry loop.

Retries are bounded at 3, after which the move fails with the existing contention message.

---

## 6. Size limits

| Constant | Value | What it bounds |
|---|---|---|
| `MAX_MOVE_FOLDERS` | 200 | folders in the subtree — also the per-statement binding count |
| `MAX_BATCH_STATEMENTS` | 900 | statements in one batch |
| `MAX_MOVE_ANCESTOR_ROWS` | 20 000 | `file_folder_ancestors` rows written |
| `MAX_MOVE_FILES` | 50 000 | rows one `UPDATE` touches — a time-limit guard, not a batch one |

**Where the numbers come from.** `visibility.d1.ts` already records the one hard constraint the
project reasons about: SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 999, D1 rejects
statements carrying more, and that file chose `MAX_ACTOR_PRINCIPALS = 200` to stay well inside
it. The file statements here bind one parameter per folder in the subtree, so `MAX_MOVE_FOLDERS`
takes the same 200 rather than inventing a number. `MAX_COPY_FOLDERS` (2000, in
`folder.service.ts`) is the precedent for the *shape* of the refusal — a controlled
`ValidationError` naming the limit — but not for the size, because a copy is not bound to one
batch.

**Files are no longer a batch constraint.** The old rebuild emitted one statement per
(file, ancestor) pair, so the batch grew with the file count and a folder holding ten thousand
files could not be moved atomically at all. The rebuild is now per folder —
`INSERT ... SELECT ... WHERE files.folder_id = ?` — so the count is `folders × depth` and the
file count does not appear in it. A test asserts exactly this: adding a file must not add a
statement.

**On exceeding a limit**, `SubtreeTooLargeError` (422) is raised **before the batch opens**, so
nothing is written; counts are logged at warn for administrators. The folder ceiling is checked
*first*, ahead of the file reads — those reads bind one parameter per folder, so on a genuinely
oversized subtree they would fail with a raw `Failed query: select count(*)` instead of the
controlled refusal. That ordering bug was caught by the test that asserts the error *type*.

Splitting a large move across several committed batches is deliberately **not** done: it would
reintroduce exactly the window this module closes, with a bigger blast radius. A very large tree
needs an asynchronous migration with its own progress and resumption model.

---

## 7. Provider combinations

| `DATA_SOURCE_FOLDERS` | `DATA_SOURCE_FILES` | Folder move |
|---|---|---|
| mongo | mongo | existing Mongo path, `withTransaction`, unchanged |
| d1 | d1 | atomic D1 unit-of-work |
| d1 | mongo | **refused** — `SplitDataSourceMoveError` (409) |
| mongo | d1 | **refused** — `SplitDataSourceMoveError` (409) |

Fails closed. No transaction spans MongoDB and D1, so a split-configuration move cannot be made
atomic by any means available — it would commit one half to one database and attempt the other
half against a second, which is the original bug with a wider gap. The error names both flags in
its details and is logged at error.

Reads under a split configuration are unaffected. Only hierarchy *mutations* are refused.

`hierarchyMutationEngine()` is the single decision point, and is unit-tested directly against
all four combinations rather than only through the service.

---

## 8. Audit

Unchanged, and already correct: `folder.service.ts` records `folder.move` **after** the
hierarchy write returns and after the row is re-read. A refused or rolled-back move throws before
reaching it, so no success event is ever written for a move that did not happen.

---

## 9. FTS

A move writes no indexed column, and the unit-of-work adds **no** FTS refresh — `files_fts`
indexes display name, original filename, tags and metadata, none of which contain folder path
information.

One caveat worth recording: the `files` UPDATE in step 4 still fires `trg_files_fts_update`,
which rebuilds each affected file's index row from unchanged tags and metadata. The result is
identical text, so this is write amplification rather than incorrectness. Removing it would mean
narrowing the trigger to the columns that actually matter, which is a schema migration and is not
done here.

---

## 10. Rollback

Revert the commits. The change is inert in production: both flags are unset, so
`hierarchyMutationEngine()` returns `mongo` and the untouched MongoDB path runs.

Reverting only the unit-of-work while leaving the repository refactor is also safe — `moveSubtree`
and `reparentSubtree` still work standalone, and the service would fall back to the two-batch
sequence with the window reopened.

---

## 11. The same window still exists for trash, restore and archive

Scoped out of this session, which was specifically about the move, but it is the same defect and
it should not be discovered again from scratch. `folder.service.ts` still does two sequential
D1 batches in three other places:

| Operation | Line | Calls |
|---|---|---|
| trash a folder | ~654 | `folderRepository.setSubtreeDeleted` then `fileRepository.setSubtreeDeleted` |
| restore a folder | ~733 | the same pair with `deleted: false` |
| archive / unarchive | ~769 | `folderRepository.setSubtreeStatus` then `fileRepository.setSubtreeStatus` |

The consequence is milder than for a move — these change `status` and `deleted_at`, not the
closure table, so a half-applied trash leaves files visible in a trashed folder rather than
mis-inheriting an ACL. But a folder in the trash whose files still read as active is still wrong,
and `listTrashed` will disagree with the folder listing.

The fix is mechanical now that the pattern exists: extract `buildSubtreeDeletedStatements` and
`buildSubtreeStatusStatements` in both repositories and add two more composed operations
alongside `moveFolderSubtreeWithFiles`. Neither needs the ordering trick — there is no depth
shift to compute — so both are simpler than the move.

---

## 12. Verification

Run against the finished module, on the `cloudflare-migration` branch with a clean tree.

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run test:mongo` | 49 files, 722 tests, all pass |
| `npm run test:d1` | 9 files, 369 tests, all pass — includes the 23 in `hierarchy-unit-of-work.test.ts` |
| `npm run cf:build` | pass — `.open-next/worker.js` produced |
| `npm run cf:preview`, both flags on D1 | module graph loads in `workerd` |

**The preview check, precisely.** `DATA_SOURCE_FOLDERS=d1` and `DATA_SOURCE_FILES=d1` in
`.dev.vars`, worker booted on 127.0.0.1, then `GET /api/health` → **200** and
`POST /api/folders/:id/move` → **401 `UNAUTHENTICATED`**. The 401 is the point: the request
reached the authentication layer, so the folder service and both D1 repositories resolved and
instantiated inside `workerd`. No authenticated move was performed — that needs a seeded
identity and is not claimed here. Atomicity itself is proven by the integration tests, which run
against real D1, not by this check.

**One preview papercut, not a code defect.** `cf:preview` runs with `NODE_ENV=production`, and
the environment schema requires `APP_URL` to be `https://` in production. The `APP_URL=http://…`
that `.dev.vars.example` ships therefore makes *every* route return 500 with
`APP_URL must use https:// in production` — including `/api/health`, which is misleading when
what you are trying to verify is a module graph. Set `APP_URL=https://localhost:8788` in
`.dev.vars` before `cf:preview`. This predates module 7 and affects any preview run.

`.dev.vars` was restored afterwards; no data-source flag is set in any committed file.

---

## 13. Status

| Step | State |
|---|---|
| Atomic D1 folder+file move | done |
| Injected-failure rollback proven, both halves | done |
| Stale-plan guard covering both halves | done |
| Split-provider moves blocked | done |
| Size limits with controlled refusal | done |
| File-version domain on D1 | not started |
| Mongo `aggregate` soft-delete inconsistency | still open — §6.3 of module 6 |

Production configuration is unchanged: both flags unset, MongoDB serving every request.
