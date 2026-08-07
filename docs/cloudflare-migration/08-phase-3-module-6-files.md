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

## 3. Status of this module

See the final report in the session that lands each commit. This document is written as the
work proceeds rather than after it, so a half-finished module is visible as such.
