# Cloudflare Migration — Phase 3, Module 6: The File Repository

**Status:** in progress. MongoDB remains the live database. No UI file changed.
**Predecessors:** [`07-…module-5-folders.md`](./07-phase-3-module-5-folders.md)
**Scope:** file metadata. File *versions*, reviews, inventory and notifications are untouched.

---

## 1. What the MongoDB repository actually contains

`src/server/repositories/file.repository.ts`, 966 lines, 27 public methods plus three
helpers (`isValidId`, `toRecord`, `newId`). Three things about it shape the whole migration:

1. **`findById` takes no actor.** It is not permission-aware; every caller is expected to run
   `file-access.ts` afterwards. The brief (§5) requires the user-facing lookup to enforce
   visibility in SQL, so this signature changes — the same change the folder module made.
2. **Visibility arrives as a `Record<string, unknown>` MongoDB filter fragment**, built by the
   service and passed in. That means nothing to SQL, so reads take an `Actor` instead and each
   implementation builds its own predicate.
3. **`updateById` takes raw update documents** — `$set`, `$inc`, `$unset`, and *dotted*
   `metadata.<key>` paths. Fifteen call sites use it. It becomes a `FilePatch`.

### Where the searchable data lives

D1 splits what MongoDB kept in one document:

| MongoDB | D1 |
|---|---|
| `files.metadata` (sub-document) | `file_metadata(file_id, key, value)` |
| `files.tags[]` | `resource_tags(resource_type, resource_id, tag)` |
| `files.folderPathAncestors[]` | `file_folder_ancestors(file_id, ancestor_id, depth)` |
| `files.permissions[]` | `resource_permissions(resource_type, resource_id, …)` |
| `$text` index | `files_fts` (FTS5, standalone) |

**No Google Drive id is stored on `files`.** `file.model.ts` states the rule — a `File` never
holds a storage location — and the D1 schema repeats it. Drive ids live on `file_versions`, so
a "find by Drive file id" for a *file* is a join through versions.

### FTS synchronisation is trigger-maintained, but only off `files`

`trg_files_fts_insert/update/delete` fire on the `files` table. They read `resource_tags` and
`file_metadata` to build the `keywords` and `description` columns — but **nothing fires when
those two tables change**. The insert trigger writes empty keywords, because at insert time the
tag and metadata rows do not exist yet.

Consequence for this module: after writing tags or metadata, the repository must touch the
`files` row so `trg_files_fts_update` re-reads them. That is not a workaround, it is the
contract the triggers were written to; it is asserted by a test rather than left to memory.

---

## 2. Method mapping

"Visibility" is the predicate applied **inside** the query. `lookup` is `lookupVisibility()`,
`child` is `childVisibility()`, `resource` is `resourceVisibility()` — all from
`visibility.d1.ts`, already built and tested in module 4.

| MongoDB method | D1 method | Tables | Visibility | Atomic | Internal | Tests |
|---|---|---|---|---|---|---|
| `findById(id)` | `findById(actor, id)` | `files`, `file_folder_ancestors`, `file_metadata`, `resource_tags`, `resource_permissions` | `lookup` | — | no | 1–20, 28 |
| `findByIds` | `findByIds(actor, ids)` | as above | `lookup` | — | no | 22, 23 |
| `listInFolder` | same, takes `actor` | as above | `child` | — | no | 26, 27 |
| `listTrashed` | same, takes `actor` | as above | `child` | — | no | 24 |
| `search` | same, takes `actor` | as above + `files_fts` | `resource` | — | no | 21, 29, §9 |
| `listSharedWith` | same, takes `actor` | as above | principals + live-grant `EXISTS` | — | no | 25 |
| `searchFacets` | same, takes `actor` | `files`, `resource_tags` | `resource` | — | no | facets |
| `findRelated` | same, takes `actor` | `files`, `file_metadata` | `resource` | — | no | related |
| `projectContentBreakdown` | same, takes `actor` | `files`, `file_metadata` | `resource` | — | no | breakdown |
| `countForExperiment` | same | `files` | — counter for a project view already authorised | — | no | counters |
| `existsWithName` | same | `files` | — name collision inside an authorised folder | — | no | names |
| `takenNamesInFolder` | same | `files` | — names only, inside an authorised folder | — | no | names |
| `findByChecksumInFolder` | same | `files` | — duplicate-upload warning | — | no | checksum |
| `countInFolder` | same | `files` | — | — | no | counters |
| `findByChecksum` | `findByChecksumInternal` | `files` | **bypass** — storage dedupe decision, never discloses location | — | **yes** | checksum |
| — (new) | `findByIdInternal` | `files`, … | **bypass** — re-read after a write this request made | — | **yes** | §5 |
| — (new) | `findByIdsInternal` | `files`, … | **bypass** — complete set for subtree mutations | — | **yes** | §5 |
| — (new) | `findByDriveFileIdInternal` | `files`, `file_versions` | **bypass** — Drive change feed, runs as the sync worker | — | **yes** | Drive lookup |
| `findExpiredTrash` | `findExpiredTrashInternal` | `files` | **bypass** — retention purge runs as no user | — | **yes** | retention |
| `newId` | same | — | — | — | no | — |
| `create` | same | `files`, `file_folder_ancestors`, `file_metadata`, `resource_tags` | service authorises | `batch` | no | create, ancestors, FTS |
| `updateById(update)` | `updateById(id, FilePatch)` | `files`, `file_metadata`, `resource_tags`, `resource_permissions` | service authorises | `batch` | no | rename, metadata |
| `updateByIdWhere` | same, guarded | `files` | service authorises | guarded stmt | no | approval race |
| `setDeleted` | same | `files` | service authorises | `batch` | no | trash/restore |
| `setDeletedBySystem` | same | `files` | **bypass** — Drive change feed | stmt | **yes** | Drive trash |
| `setSubtreeDeleted` | same | `files`, `file_folder_ancestors` | service authorises at subtree root | `batch` | no | folder trash |
| `reparentSubtree` | same | `files`, `file_folder_ancestors` | service authorises both ends | `batch` | no | §20 |
| `setSubtreeStatus` | same | `files`, `file_folder_ancestors` | service authorises | `batch` | no | archive |
| `unlinkExperiment` | same | `files` | service authorises | stmt | no | experiment delete |
| `purge` | same | `files`, cascades | **bypass** — retention job | `batch` | **yes** | purge |
| — (new) | `checkFileHierarchyIntegrity` | `files`, `file_folder_ancestors` | admin/test tooling | — | no | §19 |

`isValidId` and `toRecord` are BSON-local helpers with no D1 counterpart.

---

## 3. Call-site mapping

Every production caller of the old repository, and what it became. "Internal" means the call
sites an authorization bypass, and the column says why that is legitimate.

| Service | Old call | New call | Classification |
|---|---|---|---|
| `file-access.ts` | `findById(id)` | `findById(actor, id)` | actor — the user-facing lookup |
| `file.service.ts` | `listInFolder({visibility})` | `listInFolder({actor})` | actor |
| `file.service.ts` | `findRelated({visibility})` | `findRelated({actor})` | actor |
| `file.service.ts` | `listTrashed({visibility})` | `listTrashed({actor})` | actor |
| `file.service.ts` | `findById(id)` after restore | `findByIdInternal(id)` | internal — re-read of a row this request wrote |
| `file.service.ts` | `findExpiredTrash` | `findExpiredTrashInternal` | internal — retention purge |
| `search.service.ts` | `search({visibility})` | `search({actor})` | actor |
| `search.service.ts` | `searchFacets(vis, org)` | `searchFacets(actor)` | actor |
| `project.service.ts` | `projectContentBreakdown(vis, id)` | `(actor, id)` | actor |
| `sharing.service.ts` | `listSharedWith({organizationId})` | `listSharedWith({actor})` | actor |
| `comment.service.ts` | `loadFileContext(id)` | `loadFileContext(actor, id)` | actor |
| `drive-sync.service.ts` | `findById(id, {includeDeleted})` ×2 | `findByIdInternal` | internal — sync worker, no user |
| `approval-integrity.service.ts` | `findById(id, {includeDeleted})` | `findByIdInternal` | internal — background sweep |
| `storage-migration/local-copies.ts` | `findById(id, {includeDeleted})` | `findByIdInternal` | internal — storage sweep |
| `upload.service.ts` | `findById(id)` | `findByIdInternal(id)` | internal — describes the upload just finalized |
| `migration.service.ts` | `findByChecksum` | `findByChecksumInternal` | internal — storage dedupe |
| `scripts/purge-trash.ts` | `findExpiredTrash` | `findExpiredTrashInternal` | internal — runs as no user |

Every `updateById` call site moved from `$set`/`$inc`/`$unset` to `FilePatch`; the two
`updateByIdWhere` sites moved to `FileGuard`.

---

## 4. Residual direct `FileModel` usage

Re-audited after the refactor. **No user-facing request service reads `FileModel` directly.**
What remains, and why:

| File | Classification | Disposition |
|---|---|---|
| `repositories/storage-usage.repository.ts` | Quota aggregation over all files | Its own module (storage usage) later in Phase 3 |
| `services/storage-migration/planner.ts` | Drive byte-migration planner | Drive storage phase |
| `services/storage-migration/drive-mirror.ts` | Drive mirror bookkeeping | Drive storage phase |
| `services/storage-migration/pending-transfers.ts` | Transfer queue | Drive storage phase |
| `services/storage-migration/transfer.ts` | Transfer state writes | Drive storage phase |
| `scripts/validate-acl-uniqueness.ts` | Pre-migration ACL validation | Script, MongoDB-only by design |
| `scripts/db/2026-08-01-storage-provider-fields.ts` | One-off backfill | Historical, MongoDB-only |

The four `storage-migration/*` files and `storage-usage.repository.ts` are the real debt: they
are production code that stays pinned to MongoDB when `DATA_SOURCE_FILES=d1`. They are all part
of the *Drive byte-migration* subsystem, which has not been migrated and is not in module 6's
scope — the same disposition the folder module recorded for `folder-mirror.ts`. Nothing in the
normal drive UI path reaches them.

---

## 5. The Drive-id lookup, and the one place organization scoping is absent

`findByDriveFileIdInternal(googleDriveFileId)` resolves

```text
file_versions.googleDriveFileId → file_versions.fileId → files._id
```

No Drive id is stored on `files`, and none is being added to simplify this: the rule that a
`File` holds no storage location is the reason the column does not exist, and duplicating it
would create a second copy to keep in step. Reading `file_versions` here is a *join*, not the
start of file-version migration — no version-domain behaviour (creation, approval, restoration,
history) is implemented in this module.

**The lookup takes no `organizationId`, deliberately.** It is the one method in this contract
with no tenant filter, so the reasoning is recorded rather than left to be rediscovered:

- A Google Drive id is unique across the entire mirror. The unique partial index on
  `file_versions.googleDriveFileId` carries no organization component, so one id resolves to at
  most one version regardless of tenant.
- The Drive change feed starts from a Drive id with **no organization in hand**. Scoping the
  lookup would make another tenant's change resolve to `null`, be filed as an unmanaged item,
  and the mirror's disagreement would never be reported — the failure the lookup exists to
  prevent.
- Isolation is therefore the *caller's* obligation, and `FileRecord.organizationId` is returned
  so the caller can discharge it. The method is an authorization bypass reached only by the sync
  worker; the architectural tests assert no API route imports an implementation or calls a
  bypass.

Ambiguity fails rather than guesses. The query reads **two** rows, not one: a `findOne` cannot
distinguish "resolved" from "ambiguous". Two distinct `fileId`s for one Drive id logs the
integrity problem and raises `AmbiguousDriveFileError`, because picking one arbitrarily would
file a Drive change against the wrong research record.

Trashed files resolve on purpose — a change arriving for a file trashed on this side is still
ours.

Five tests cover it (`tests/security/file-repository-boundary.test.ts`): resolution through
`file_versions`, unknown and empty ids returning `null`, the trashed case, the cross-organization
case above, and deterministic failure on duplicate linkage.

---

## 6. The D1 implementation

`file.repository.d1.ts` implements all 31 contract methods. `DATA_SOURCE_FILES=d1` now resolves
to it; `D1FileRepositoryUnavailableError` is gone.

### 6.1 Tables

`files`, `file_folder_ancestors`, `file_metadata`, `resource_tags`, `resource_permissions`, plus
`folders`/`folder_ancestors` (structural checks and subtree rebuilds), `file_versions` (the Drive
id join only) and `files_fts`.

### 6.2 Authorization

Every actor-facing read applies a predicate from `visibility.d1.ts` **inside** the SQL — the same
predicate for the rows and for the `COUNT(*)` that produces `total`, built once and used twice.
Nothing is filtered in JavaScript.

| Read | Predicate |
|---|---|
| `findById`, `findByIds` | `lookupVisibility('file', actor)` |
| `listInFolder`, `listTrashed` | `childVisibility('file', actor)` |
| `search`, `searchFacets`, `findRelated`, `projectContentBreakdown` | `resourceVisibility('file', actor)` |
| `listSharedWith` | live non-deny entries naming the actor's principals |

That mapping is identical to the Mongo implementation's, so the flag cannot change who sees what
— with one exception, which is a **tightening**:

`findById` on MongoDB applies only `lookupGuardFilter` (organization isolation and the live deny
guard), because MongoDB cannot check an ancestor's ACL inside a `find` filter and a narrower
predicate would 404 the ordinary inherited-access case. D1 has `file_folder_ancestors`, so
`lookupVisibility` applies in full: inherited grants, inheritance boundaries, role scope and the
confidentiality gate all run in the query. A guessed id cannot load a row the actor has no route
to. `assertCan` still makes the real decision afterwards on both engines.

### 6.3 One deliberate behavioural divergence

`applySoftDeleteFilter` hooks `find`, `findOne`, `findOneAndUpdate`, `countDocuments`,
`updateMany` and `updateOne` — but **not** `aggregate`. On MongoDB, `searchFacets` and four of
the five `projectContentBreakdown` figures therefore count trashed files, while the fifth
(`linkedToExperiment`, a `countDocuments`) excludes them. The dashboard disagrees with itself.

D1 excludes soft-deleted rows everywhere, consistently. Reproducing the inconsistency would mean
carrying a known reporting bug into the new engine and then defending it in the Phase 6
comparison — the same reasoning that reversed the plan to reproduce the ACL leak in module 4.

**Outstanding:** the Mongo side should be fixed to match. It is a live dashboard, so it is
recorded here rather than changed in a session whose remit was the D1 implementation.

### 6.4 FTS synchronisation — a correctness fix

The Phase 2 triggers fire on `files` only. `trg_files_fts_update` re-reads tags and metadata when
it runs, but a write touching *only* `file_metadata` or *only* `resource_tags` fires no trigger at
all. Editing a sample id or a tag left `files_fts` holding the previous value: the new term
matched nothing, and the old term still matched.

`refreshFileFts(db, fileId, content)` emits a DELETE and an INSERT that join the **same batch** as
the write that made them necessary, so the index cannot be left stale by a later failure. It is
appended by `create` and by any patch touching `displayName`, `originalFilename`, `tags`,
`metadataSet`, `metadataUnset` or `status`. `content: null` deletes without reinserting,
reproducing the trigger's `WHERE deleted_at IS NULL`, so a trashed file leaves the index entirely.

DELETE-then-INSERT rather than UPDATE because `files_fts` is a standalone FTS5 table with no
unique constraint on `file_id` — an INSERT alone accumulates a row per write and every search
returns the file once per stale copy. The pair is idempotent, so it is also safe after a
statement whose trigger already rebuilt the row.

Two implementation constraints are worth recording:

* **A D1 batch cannot carry parameterised raw SQL.** `SQLiteD1Session.batch` reads
  `preparedQuery.stmt` for any query with bound parameters, and `db.run(sql\`...\`)` does not set
  it — the batch dies with "cannot read properties of undefined". Only query-builder statements
  work. That ruled out the `INSERT ... SELECT` form, so `files_fts` is declared as a local
  drizzle table (deliberately *not* in `schema/index.ts`, or drizzle-kit would try to create it)
  and the indexed text is computed in JavaScript by `ftsContentOf`, which mirrors the trigger's
  expressions. **If `trg_files_fts_update` changes, `ftsContentOf` must change with it.**
* **`meta.changes` is not a matched-row count.** It includes rows written by triggers and by
  `ON DELETE CASCADE`. Purging one file reported 6; restoring one reported 4. Those numbers reach
  callers and audit entries, so `setSubtreeDeleted`, `purge`, `unlinkExperiment` and
  `setDeletedBySystem` read the matching ids first and count those.

### 6.5 `file_folder_ancestors`

The chain is root → containing folder, with the **containing folder last** — `folderPathAncestors`
has always ended with `folderId`, `checkFileHierarchyIntegrity` asserts it, and the inheritance
predicate depends on it (a file inherits from the folder it is in, which it can only do if that
folder is one of its ancestor rows). A file in `Root/Project/Experiment/Results` gets four rows,
at depths 0–3.

`create` writes the base row and the chain in one `db.batch()`; a file whose ancestor rows did not
land would be invisible to every subtree query *and* to the inherited-deny guard, so it would be
more visible than intended, not less.

`reparentSubtree` rebuilds each affected file's chain rather than shifting depths. The obvious
implementation needs each file's current depth of the moved folder, and that value changes as the
same statement updates it — a correlated sub-query reading the table being written. So the suffix
comes from `folder_ancestors`, which the statement does not write, and which gives the same answer
before and after `moveSubtree` because a move does not change the structure *below* the moved
folder.

`checkFileHierarchyIntegrity` additionally verifies that depths are the contiguous run `0..n-1` —
meaningless for an array, load-bearing for a closure table, because `boundaryDepth()` compares
depths and a gap silently changes which ancestors are in scope.

### 6.6 What the shared unit-of-work must call

Not built in this session (§13 of the brief). `folder.service.ts` currently does:

```text
folderRepository.moveSubtree(...)     // batch 1 — folders + folder_ancestors
fileRepository.reparentSubtree(...)   // batch 2 — files + file_folder_ancestors
```

Two batches, so a crash between them leaves folders moved and files pointing at the old chain.
The shared `d1-unit-of-work.ts` must compose, in one batch and in this order:

1. `folders` UPDATE (parent, drive type, department, project, owner) with the optimistic guard;
2. `folder_ancestors` rewrite for the moved folder and every descendant;
3. `files` UPDATE for the subtree (drive type, department, project);
4. `file_folder_ancestors` rewrite for every file in the subtree;
5. no FTS refresh — a move changes no indexed column.

Step 4 currently reads `folder_ancestors` *after* step 2 has run. Inside one batch it cannot, so
the composed version must compute both chain sets in JavaScript before the batch opens, from the
folder chains it already read. Both repositories need to expose their statement builders rather
than only their `await`-ing methods; neither does yet.

Note also that `reparentSubtree` emits one statement per (file, ancestor) pair. Chains are single
digits deep, but a very large subtree will need chunking before this is used on production-scale
data.

---

## 7. Status of this module

| Step | State |
|---|---|
| Contract and method mapping | done (`05a8257`) |
| Mongo implementation behind the contract, services rewired, routing flag | done (`c8d0010`, `b8b4c1d`) |
| Drive-id lookup boundary tested on both engines | done (`4ac4d0d`) |
| D1 implementation, FTS refresh, D1 routing | done |
| Folder+file atomic move / shared unit-of-work | **not started** — §6.6 |
| Mongo `aggregate` soft-delete inconsistency | **not fixed** — §6.3 |
| File-version domain on D1 | not started |
| Dedicated D1 search module | not started (module 8) |

Production configuration is unchanged: `DATA_SOURCE_FILES` is unset, so MongoDB serves every
request. Nothing silently substitutes one database for the other in either direction.

This document is written as the work proceeds rather than after it, so a half-finished module
is visible as such.
