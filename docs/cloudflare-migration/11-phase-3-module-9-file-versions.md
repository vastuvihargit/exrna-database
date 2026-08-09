# Phase 3, module 9 — file versions on D1

**Status: complete.** The repository, its routing, the atomic version write and the migration
validator are implemented and proven by execution — 37 tests against real D1, and every gate in
§12.1 run to completion. Nothing here is enabled in production.

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

## 12. Verification

`tests/d1/file-version-repository.test.ts` — **37 tests, all passing** against real D1 through
the Miniflare harness. No repository behaviour is mocked; every assertion goes through
`file-version.repository.d1.ts` and `createVersionWithFile()`.

### The two that justify the harness

**Concurrent numbering.** Two `createVersionWithFile` calls are held at a barrier until both have
read the *same* `nextVersionNumber`, then released together. Without the barrier the test would
pass for the wrong reason — `await` boundaries usually let the first insert land before the
second reads, so the retry path would never run. The test asserts the read count exceeded two,
which is how it knows a collision actually happened and the retry actually recovered. Result:
numbers `[1, 2]`, both versions present, exactly one current, `version_count` 2, no orphan.

**Rollback, both halves.** Injected by real constraint violation, never by mocking `withBatch`:

| Poisoned half | How | Asserted |
|---|---|---|
| version INSERT | `uploaded_by` naming a user that does not exist | file pointer, `version_count` and previous `is_current` all unchanged; no partial version |
| file UPDATE | an extra `files.folder_id` naming a folder that does not exist | the **valid** new version row is absent; the file half is unchanged |

The second is the one that matters: the version INSERT was valid and would have committed alone.

### Everything else covered

Sequential numbering and `version_count`; manual duplicate `(file_id, version_number)` rejected;
`assertCurrentVersionInvariant` after every creation; approval surviving a new version with
`approvedBy`/`approvedAt`/`approvedRevisionId` intact while the *file's* pointer clears; restore
producing v4 from v1 with `restored_from_version_id` and the source checksum, v1 untouched;
checksum and storage key unwritable through `updateFlags` even when the type is cast away; the
read surface including paging and storage locations; Drive-id resolution, duplicate rejection,
and ambiguity failing loudly with the index dropped; `setCurrent` in isolation; purge counts and
idempotence; all four provider combinations; and the validator's checks with a re-run proving it
changed nothing.

### Two findings from writing the tests

**`setCurrent()` alone breaks the invariant, by design.** It moves `is_current` and leaves
`files.current_version_id` pointing elsewhere. That is correct for its one caller but wrong for
an upload, so there is now a test pinning the behaviour with a comment saying not to reach for
it as a shortcut.

**The orphan check cannot be provoked on D1.** `file_versions.file_id` is a real foreign key, so
a version whose file is missing is neither insertable nor createable by deleting the parent —
both are refused, and a test asserts the refusal. `missing_parent_file` stays in the validator
because it targets a *copy of the Mongo corpus* loaded before constraints are enforced, which is
precisely the case it was written for. Faking the corruption to make the test green would have
proven nothing.

### Authorization, which this module does not own

A version id is not a capability, and the version repository takes no `Actor` on either engine.
The boundary is one level up and is always the same two lines:

```ts
const context = await requireFile(actor, fileId, <permission>);
if (!version || version.fileId !== fileId) throw new NotFoundError();
```

`tests/security/search-and-versioning.test.ts` — *a version id is not a capability* — pushes
every service that accepts a caller-supplied version id (`download`, `restoreVersion`,
`updateVersionNote`, `listVersions`) through the six ways access can be absent: a version
belonging to another file the actor **does** own (the case where `requireFile` passes and only
the second line stands between the caller and somebody else's bytes), a fully-privileged actor
in another organization, an explicit deny over a working share, a broken inheritance boundary
with the parent folder still shared, and an expired grant written straight onto the ACL because
`sharingService.share` correctly refuses a past expiry.

`tests/security/file-repository-boundary.test.ts` adds the structural half: neither
`file-version.repository.d1.ts` nor `file-version.validator.d1.ts` imports Mongoose or a `node:`
built-in, and the contract imports both `mongoose` and `file-version.model` as types only — a
value import of the model file would drag a schema, and therefore the driver, into the Worker
bundle on the busiest write in the product.

### 12.1 Gates

Run 2026-08-09 on the migration branch, in this order, nothing skipped.

| Gate | Command | Result |
|---|---|---|
| Module suite | `vitest run --config vitest.d1.config.ts tests/d1/file-version-repository.test.ts` | **37 passed** |
| Full D1 suite | `npm run test:d1` | **430 passed**, 11 files |
| Full Mongo suite | `npm run test:mongo` | **732 passed**, 49 files |
| Typecheck | `npm run typecheck` | clean |
| Lint | `npm run lint` | clean (one pre-existing unused-variable warning in a test) |
| Worker build | `npm run cf:build` | bundle written to `.open-next/worker.js` |
| Worker preview | `npm run cf:preview` with eight `DATA_SOURCE_*` flags on `d1` | boots and serves |

**The preview check, precisely.** `.dev.vars` carried `DATA_SOURCE_USERS`, `_DEPARTMENTS`,
`_ROLES`, `_PROJECTS`, `_EXPERIMENTS`, `_FOLDERS`, `_FILES` and `_FILE_VERSIONS` all set to
`d1` — the whole migrated set, not just this module's flag, because a version write reaches the
file repository and a module graph that loads one but not the other proves nothing.

`workerd` served `/login` at 16,432 bytes (byte-identical to Phase 1), `/api/health` 200,
`/api/version` 200, and `/api/health/ready` 200. Every route whose handler imports a D1
repository — `/api/drives`, `/api/search`, `/api/recent`, `/api/starred`, `/api/trash`,
`/api/shared`, `/api/files/:id/versions` — returned **401 UNAUTHENTICATED**, which is the
result that matters: a 500 would mean the module graph failed to resolve in `workerd`, and a 401
means it resolved and the authentication layer ran. The `DB` binding was confirmed present
through the local explorer API.

Two observations from the preview, neither a defect in this module and both recorded for later
phases: `/api/health/ready` reports `storage.provider: "local"` inside a Worker that has no
filesystem, and the same one-line papercut Phase 3 module 7 recorded — `cf:preview` runs with
`NODE_ENV=production`, so `APP_URL` must be `https://` in `.dev.vars` or every route 500s on the
environment schema before reaching any handler.

`workerd` processes were terminated and `.dev.vars` restored to its committed shape afterwards.

Production configuration is unchanged: every data-source flag is unset and MongoDB serves every
request.
