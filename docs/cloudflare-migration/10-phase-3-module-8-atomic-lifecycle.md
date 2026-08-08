# Phase 3, module 8 — atomic folder + file trash, restore and archive on D1

Closes the last cascading-mutation gap in the drive. Trash, restore, archive and unarchive now
each commit the folder subtree and every affected file in **one D1 batch**, or commit nothing.
Together with module 7's move, every folder operation that touches files is now atomic.

---

## 1. What was wrong

`folder.service.ts` ran each of these inside `withTransaction`:

```text
folderRepository.setSubtreeDeleted(...)   // D1 batch 1 commits
fileRepository.setSubtreeDeleted(...)     // D1 batch 2 commits
folderRepository.adjustChildFolderCount() // D1 batch 3 commits
```

On MongoDB the session made those one unit. On D1 it made them nothing of the kind —
`withTransaction` opens a **Mongo** session, which governs no D1 statement.

**The consequence is milder than a half-applied move, and worse than it first looks.** These
statements write `status`, `deleted_at` and `trashed_with_folder_id`, not the closure table, so
nothing mis-inherits an ACL. A half-applied trash leaves a folder in the trash whose files still
read as active: `listTrashed` disagrees with the folder listing, and the files stay in
`files_fts` and keep appearing in search.

The lasting damage is to `trashed_with_folder_id`. That column is how a restore knows which
files this deletion swept in, as opposed to files the user had trashed deliberately beforehand.
If the file half never ran, the tag was never written — so a later restore cannot identify the
set it is supposed to bring back. The failure corrupts *the record of what happened*, and no
subsequent operation can reconstruct it.

---

## 2. The atomicity boundary

`src/server/db/d1-unit-of-work.ts`, alongside the move:

| Operation | Function |
|---|---|
| trash | `trashFolderSubtreeWithFiles()` |
| restore | `restoreFolderSubtreeWithFiles()` |
| archive / unarchive | `setFolderSubtreeStatusWithFiles()` |

Trash and restore are one implementation, `sweepFolderSubtreeWithFiles(input, deleted)`, because
they differ only in a predicate and a field set. The unit-of-work is **not** an authorization
boundary: the service authorises before calling it, exactly as for a move.

### The batch, in order

**Trash / restore** — 3 statements, or 2 for a drive root:

| # | Statement |
|---|---|
| 1 | the folder the user acted on (`trashed_with_folder_id` stays null on its own row) |
| 2 | every descendant folder matching the sweep predicate |
| 3 | every file in the subtree matching the sweep predicate |
| 4 | the parent's `child_folder_count`, −1 trashing and +1 restoring |

**Archive / unarchive** — 3 statements:

| # | Statement |
|---|---|
| 1 | the folder the user acted on, including `archived_at` |
| 2 | every descendant folder, `status` only — `archived_at` stays null |
| 3 | every **live** file in the subtree |

Order is not load-bearing here — no statement reads a table another one writes — but it matches
the order the Mongo transaction uses so the two engines read the same way.

---

## 3. Why there is no `updated_at` guard

The move needs one. Its statements carry values a prior read supplied — a depth shift that is
wrong if the folder moved in between — and applying half a shift to a closure table produces a
quietly malformed tree.

Nothing here is like that. Every lifecycle statement is set-wise and its predicate is evaluated
by SQLite at execution time, so the batch acts on whatever the subtree actually is when it runs.
The only values read in advance are the two **counts**, and a count that raced is a slightly
stale audit number, not a corrupt hierarchy. Adding a guard would buy nothing and would make a
concurrent unrelated rename fail a delete.

---

## 4. Statement builders

Extracted so one implementation serves both the standalone repository method and the composed
batch — the same split module 7 introduced for the move.

| Repository | Builders | Counters |
|---|---|---|
| `folder.repository.d1.ts` | `buildFolderSubtreeDeletedStatements`, `buildFolderSubtreeStatusStatements` | `countFolderSubtreeSweep`, `countFolderSubtreeStatus` |
| `file.repository.d1.ts` | `buildFileSubtreeDeletedStatements`, `buildFileSubtreeStatusStatements` | `countFileSubtreeSweep`, `countFileSubtreeStatus` |

None of them executes anything. `setSubtreeDeleted` and `setSubtreeStatus` on both repositories
now call their own builders, so there is no second copy of the mutation logic.

### Set-wise, and why that fixed a latent bug

The file half used to read the matching ids and bind them into `WHERE id IN (...)` — **one
parameter per file**. SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 999 and D1 rejects
statements carrying more, so trashing a folder holding a thousand files would have failed
outright, and nothing in the code said so. The predicate is now applied directly, the file count
does not enter the statement, and a test trashes and restores 1200 files to hold that.

Folder statements were already set-wise, via a `folder_ancestors` sub-select, and stay that way.
So no lifecycle operation has a subtree-size ceiling and none of module 7's limits apply here.

---

## 5. Counts

Both numbers reach an audit entry, so neither is read from `meta.changes` — which counts the FTS
trigger's writes and the side tables' cascades as well, and reported 6 for one purged file. Each
count is a `count()` over the sweep's own predicate, run before the batch. This is the discipline
`matchingIds` already established on the file side, applied to folders too; the folder half
previously used `RETURNING`, which was also accurate but does not compose into a shared batch.

One quirk is **preserved deliberately**: the folder count is "descendants matched + 1" whether or
not the folder's own row matched, so trashing an already-trashed folder still reports 1. It is
pinned by a test rather than quietly corrected, because the number is business data that has
always read that way.

---

## 6. Trash, restore and archive semantics

Unchanged. This module made them atomic; it did not redefine them.

**Trash.** The folder the user acted on gets `trashed_with_folder_id = null` — nothing swept it
in. Every descendant folder and every live file in the subtree gets that column set to the
trashed folder's id, which is the record of which deletion took them.

**Restore.** Matches only rows tagged with *this* folder's id. A file or folder trashed on its
own beforehand carries a different tag, does not match, and stays in the trash. Two tests cover
this, one for files and one for folders.

**Archive.** Writes `status`, never `deleted_at`. `archived_at` is set only on the folder the
user archived, so the Archive view lists that folder and not its whole subtree. The file half
carries `live()`, so a file already in the trash keeps `status = 'trashed'` through an archive
of the folder around it and comes back as trashed, not archived. Archive and trash are separate
lifecycles and that predicate is the line between them.

---

## 7. FTS

**No FTS statement was added, and none was needed.** `trg_files_fts_update` fires on any UPDATE
to `files` and re-inserts the row only `WHERE new.deleted_at IS NULL`, so:

| Operation | Index effect |
|---|---|
| trash | row leaves `files_fts` — search cannot return it, by construction rather than by predicate |
| restore | row returns to `files_fts` |
| archive / unarchive | row stays indexed; only `status` changed |

Tests assert the `files_fts` row directly as well as the search result, because the two can
disagree — `search()` also filters on `deleted_at`, so a query-level check alone would pass even
if the index were stale. Whether archived files *should* surface in search is a query-predicate
question the search API owns; the index is not what decides it.

---

## 8. Audit and notifications

**Audit is unchanged and was already correct.** `folder.service.ts` calls `record(...)` after
the mutation returns, for all three operations. A rolled-back sweep throws before reaching it,
so no success event is ever written for something that did not happen. The counts in the trash
entry now come from the pre-batch reads described in §5.

**Notifications: none exist on these paths.** `folder.service.ts` sends no notification for
trash, restore or archive, so there was nothing to reorder. If one is added later it belongs
after the unit-of-work returns, for the same reason the audit call sits there.

---

## 9. Provider combinations

`hierarchyMutationEngine(operation)` is now the single decision point for every cascading
operation, taking a `HierarchyOperation` — `move | trash | restore | archive | unarchive` — so
the refusal, the log line and the error details all name which one was declined.

| `DATA_SOURCE_FOLDERS` | `DATA_SOURCE_FILES` | Cascading folder operation |
|---|---|---|
| mongo | mongo | existing Mongo path, `withTransaction`, unchanged |
| d1 | d1 | atomic D1 unit-of-work |
| d1 | mongo | **refused** — `SplitDataSourceHierarchyError` (409) |
| mongo | d1 | **refused** — `SplitDataSourceHierarchyError` (409) |

`SplitDataSourceMoveError` was renamed to `SplitDataSourceHierarchyError` and carries the
operation. Fail-closed behaviour is unchanged and the move's protection is not weakened — it is
the same function, now shared. Reads under a split configuration remain unaffected; only
cascading mutations are refused. All five operations are tested against all four combinations.

---

## 10. Authorization, and what these tests do not cover

The unit-of-work performs no authorization, and unlike the move it performs no structural check
either — there is no destination to validate. Trash, restore and archive act on a single subtree,
so "may this actor do this" is the only question, and `requireFolder(actor, folderId, ...)`
answers it in the service before anything is planned.

That enforcement is covered where it lives, by the Mongo service suite
(`tests/security/folder-management.test.ts`), not by the D1 lifecycle tests. What the D1 suite
adds on this point is the property the new statements are responsible for: a sweep is
subtree-scoped and cannot reach another organization's identically shaped tree.

---

## 11. Rollback

Revert the commits. The change is inert in production: both flags are unset, so
`hierarchyMutationEngine()` returns `mongo` and the untouched MongoDB path runs.

Reverting only the unit-of-work while keeping the repository refactor is also safe —
`setSubtreeDeleted` and `setSubtreeStatus` still work standalone and share the same builders, and
the service would fall back to the sequential form with the window reopened.

---

## 12. Tests

`tests/d1/lifecycle-unit-of-work.test.ts`. Failures are injected by foreign key violation, not by
mocking: `deleted_by` references `users.id`, so a sweep attributed to a user who does not exist
makes exactly one half fail inside an otherwise valid batch and exercises D1's real rollback.

| Group | Covers |
|---|---|
| trash | empty folder, files, nested subtree, counts, child-count adjustment, already-trashed, cross-organization isolation |
| restore | full subtree, individually trashed **file** stays trashed, individually trashed **folder** stays trashed |
| archive | subtree, unarchive, trashed file unaffected, `archived_at` only on the acted-on folder, idempotence |
| atomicity | file-half failure rolls back the folder half; folder-half failure rolls back the file half; restore file-half failure; archive failure |
| index | trash removes from `files_fts`, restore returns it, archive keeps it |
| scale | 1200 files trashed and restored — above the old 999-parameter ceiling |
| providers | all five operations × all four flag combinations |

Every successful-mutation test finishes with both integrity checkers returning clean.

---

## 13. Remaining non-atomic folder/file mutations

Searched for; this is the complete list as of this module.

| Operation | Shape | Assessment |
|---|---|---|
| folder move | one atomic batch | done, module 7 |
| folder trash / restore / archive | one atomic batch | done, this module |
| folder **copy** | many inserts, not batched as one unit | a partial copy leaves an incomplete *new* tree and no original is modified; it is recoverable by deleting the partial copy, unlike a partial mutation of live data. Bounded by `MAX_COPY_FOLDERS`. Not addressed here. |
| trash **purge** (retention job) | per-resource deletes | already idempotent and resumable — a re-run purges what remains |

---

## 14. Status

| Step | State |
|---|---|
| Atomic D1 folder+file move | done — module 7 |
| Atomic D1 trash / restore | done |
| Atomic D1 archive / unarchive | done |
| Split-provider cascading mutations blocked, all five operations | done |
| File-version domain on D1 | not started |
| Mongo `aggregate` soft-delete inconsistency | still open — §6.3 of module 6 |

Production configuration is unchanged: both flags unset, MongoDB serving every request.
