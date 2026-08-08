# Phase 3, module 9 — file versions on D1

**Status: partially complete.** The repository, its routing, the atomic version write and the
migration validator exist and typecheck; the D1 test suite for them does not yet. §12 says
exactly what is done and what is not. Nothing here is enabled in production.

---

## 1. The data model, unchanged

A `File` is the logical research record; a `FileVersion` is one stored revision.

```text
File
 ├─ current_version_id  ─────┐
 ├─ approved_version_id ───┐ │
 └─ versions               │ │
      ├─ v1                │ │
      ├─ v2  ◄─────────────┘ │   approved: an exact revision, not "the latest"
      └─ v3  ◄───────────────┘   current
```

Google Drive ids belong to **versions**, never to files: a file re-uploaded four times has four
Drive objects and only one of them is current. Nothing in this module puts a Drive id on `files`.

### "Current" is stored twice, deliberately

| Where | Read by |
|---|---|
| `files.current_version_id` | serving one file — avoids a second query per read |
| `file_versions.is_current` | listing a file's history — avoids a join per read |

Both are load-bearing and they must agree. The same is true of `files.approved_version_id` and
`file_versions.is_approved`. **This is the entire reason version creation cannot be two
commits**, and it is what §5 makes atomic.

---

## 2. Tables

`file_versions`, declared in Phase 2 and unchanged by this module. The constraints that matter:

| Index | Why it matters here |
|---|---|
| `ux_file_versions_number` on `(file_id, version_number)` | the authority for numbering — see §4 |
| `ux_file_versions_drive_id` on `google_drive_file_id` (partial) | one Drive object maps to one version |
| `ux_file_versions_storage_key` | two versions cannot claim the same bytes |
| `ix_file_versions_current` on `(file_id, is_current)` | the history read |

Foreign keys to `files`, `users` and (self-referentially) `file_versions.restored_from_version_id`
are enforced by D1 and were not by MongoDB. §9 is about what that will reject.

---

## 3. Routing

`DATA_SOURCE_FILE_VERSIONS`, the flag that has been in `data-source.ts` since the phase began —
no second flag was invented. Mongo is the default; only the exact string `d1` selects D1; there
is no fallback in either direction.

`file-version.repository.ts` is now a façade over `.mongo.ts` and `.d1.ts`, matching files and
folders. The Mongo implementation moved behind the contract unchanged.

---

## 4. Version numbering

`nextVersionNumber()` is **advisory on both engines**: it reads `MAX(version_number) + 1`
outside any transaction, so two concurrent uploads to the same file can read the same answer.

The authority is the unique index. `createVersionWithFile` proposes a number, and if the INSERT
collides:

* the **whole batch rolls back** — no half-made version, no repointed file;
* it re-reads the number and tries again, up to 5 times;
* after that it raises `VersionNumberContentionError` (409), which is a retry, not a 500.

So v4/v4 cannot happen, and a losing attempt leaves nothing behind to clean up. Detecting the
collision matches on the constraint message naming `file_versions`, because D1 surfaces
constraint violations as text rather than as codes — narrow on purpose, so a foreign-key failure
is not mistaken for contention and retried five times.

---

## 5. Atomic current-version write

`d1-unit-of-work.ts` → `createVersionWithFile()`. One batch:

| # | Statement |
|---|---|
| 1 | `INSERT file_versions` (`is_current = 1`) |
| 2 | every other version of the file stops being current |
| 3 | every other version still labelled `draft` becomes `superseded` |
| 4 | this version becomes current |
| 5.. | the `files` update — `current_version_id`, size, mime, checksum, filename, review reset, version count |

Step 5 reuses `planFileUpdate`, extracted from `updateByIdWhere` in the file repository, so the
file half is built by the code that already knows how — including the FTS refresh, which
**does** apply here because `files.original_filename` is an indexed column and an upload can
change it. That is the one place a version write legitimately touches the index; nothing else
in this module writes to `files_fts`.

**Still outside the batch:** cancelling open reviews and the storage-usage delta, because those
modules are still on MongoDB. Both are corrections rather than the record of what happened — a
stale open review is closed by the next reviewer action, usage is recomputed by the nightly
sweep — whereas a version that exists without its file pointing at it is not self-correcting.
They move inside when their modules migrate.

---

## 6. Mixed providers

`versionMutationEngine()` refuses a version **write** when `DATA_SOURCE_FILE_VERSIONS` and
`DATA_SOURCE_FILES` disagree, with `SplitDataSourceVersionError` (409) naming both flags.

| `FILES` | `FILE_VERSIONS` | Version write |
|---|---|---|
| mongo | mongo | existing Mongo path |
| d1 | d1 | atomic D1 batch |
| d1 | mongo | **refused** |
| mongo | d1 | **refused** |

Separate from `SplitDataSourceHierarchyError` because the pair of modules is different: a folder
move needs folders and files to agree; a version write needs files and versions to. **Reads are
unaffected** and deliberately not routed through this — a split configuration can still list
history and resolve storage locations.

---

## 7. Approved versions, restore, checksums, Drive ids

**Approved.** Untouched by this module. A new version resets the *file's* `approval_status` and
clears `approved_version_id`; it never alters the approved **version's** own `is_approved`,
`approved_by` or `approved_at`. Creating v4 while v3 is approved leaves v3 approved — "which
version did they sign?" stays answerable. Approval transitions remain the review module's.

**Restore.** Appends, never rewinds: reads the old bytes, copies them to a *new* key, and writes
a *new* version carrying `restored_from_version_id`. Old version untouched, old numbers
untouched, new version gets the next number and becomes current. Unchanged from MongoDB.

**Checksums.** Never recalculated on read and not writable through `VersionPatch` at all — the
patch type has no `checksum_sha256` and no `storage_key`, so the ordinary way to repoint a
version at different bytes now fails to compile. The Mongoose immutability hook remains
underneath as the runtime backstop, and a test asserts it by casting past the type.

**Drive ids.** Version-level metadata only. `findByDriveFileId` reads **two** rows and throws if
it finds two rather than picking one — the unique partial index makes that impossible to insert,
but rows imported from MongoDB were never constrained, so the one place that maps a Drive id
back to a version is the place to find out. No Google API client is imported here; this module
stores Drive metadata, the storage layer talks to Drive.

---

## 8. The typed patch

`updateFlags` took `Record<string, unknown>` and callers passed `{ $set: {...} }` straight to
Mongoose. That is not portable — `$set` means nothing to SQL — and not checkable: a misspelled
field wrote nothing and reported success.

It now takes `VersionPatch`. Every historical call site set fields from that list and used only
`$set`, so nothing was lost; nine call sites across four services were converted. `undefined`
means "leave alone", explicit `null` means "clear", and the difference matters — a re-approval
must wipe the previous round's supersession markers.

---

## 9. Migration validator

`file-version.validator.d1.ts` → `validateVersionGraph()`. **Read-only; it never writes.** A
validator that repaired what it found would be deciding which of two duplicate v3s is real, and
that belongs to a person who can see the file.

Checks: duplicate `(file_id, version_number)`, missing parent file, duplicate Drive ids,
`current_version_id` / `approved_version_id` pointing at another file's version or at nothing,
numbering gaps, missing checksums, organization mismatch between a version and its file, and
files with zero or several current versions.

The point is to learn *before* a migration window which rows D1's constraints will reject —
MongoDB enforced none of them, so duplicates are the likely find.

---

## 10. Authorization

Unchanged, and it is worth being exact about where it lives: **not in this repository**.

`findById(versionId)` takes no actor and cannot. The boundary is at the service:

```ts
const version = await versionRepository.findById(versionId);
if (!version || version.fileId !== fileId) throw new NotFoundError();
```

after `requireFile(actor, fileId, ...)`. That second line is what stops a guessed version id
from another file — or another organization — being readable. `version.service.ts` and
`review.service.ts` both do it today. The D1 implementation cannot close that hole and does not
pretend to; the contract says so at the method.

---

## 11. Rollback

Revert the commits. The change is inert in production: `DATA_SOURCE_FILE_VERSIONS` is unset, so
the façade returns the MongoDB implementation and the untouched Mongo path runs.

The one change that is *not* behind the flag is the typed `VersionPatch` — it altered nine call
sites and the Mongo implementation's `updateFlags`. It is behaviour-preserving (the same `$set`
is built from the patch's keys) and is covered by the existing Mongo suite.

---

## 12. Status — what is done and what is not

| Step | State |
|---|---|
| Method mapping and contract (20 methods) | done |
| Mongo implementation behind the contract | done |
| `VersionPatch` replacing raw Mongo update documents | done |
| Routing on `DATA_SOURCE_FILE_VERSIONS` | done |
| D1 implementation, full surface | done |
| Atomic `createVersionWithFile` + numbering retry | done |
| `planFileUpdate` extracted so the file half composes | done |
| Split-provider version writes fail closed | done |
| Service wiring (upload, restore) | done |
| Read-only migration validator | done |
| Typecheck | passing |
| Mongo suite | passing |
| **D1 test suite for versions** | **not written** |
| **Concurrency / rollback / parity tests** | **not written** |
| **`workerd` preview with the versions flag** | **not run** |
| **Lint, worker build re-run after the last edits** | **not run** |

Production configuration is unchanged: every data-source flag is unset and MongoDB serves every
request.
