# Phase 7 — uploads that work in a Worker

The last request path a Cloudflare Worker could not run.

`16-phase-7-storage-audit.md` classified it: 17 `getStorageProvider()` call sites across 7 files,
of which 8 — all in `upload.service.ts` — were blocking. The problem was never a scattering of
`fs` calls that could be swapped one at a time. It was the *shape* of the pipeline:

```
stream to a local quarantine directory
  → read the head back off disk to check the file signature
  → scan the quarantined object
  → rename it into originals/
  → THEN mirror to Google Drive
```

Google Drive was a mirror after a local write. `GOOGLE_DRIVE_STORAGE_ENABLED=true` changed where
bytes were copied *to*, not where they were first written, so setting it on a Worker would have
produced an `ENOENT` naming a directory nobody configured — once per upload.

## 1. What was built

A staging backend is that shape stated as an interface, so there can be two of it.

| File | What it is |
|---|---|
| `storage/staging/types.ts` | `UploadStagingBackend`, and the four properties either implementation must preserve |
| `storage/staging/local-staging.ts` | The pipeline that has been serving production, unchanged in behaviour |
| `storage/staging/drive-staging.ts` | Resumable upload into a Drive staging folder; promotion by re-parenting |
| `storage/staging/peek-head.ts` | Buffers the first 4 KB *before* anything is transferred, so a mislabelled file is refused early |
| `storage/staging/index.ts` | Selects one from `UPLOAD_STAGING`, and fails closed |

`upload.service.ts` now calls `getUploadStaging()` once instead of `getStorageProvider()` eight
times.

### 1.1 The Drive pipeline

```
authorize  (permission, extension, quota — unchanged, above the interface)
  → buffer the first 4 KB, signature-check, REJECT EARLY
  → stream the body into a Drive resumable upload in .upload-staging/,
    hashing and counting in a passthrough
  → verify size and checksum against what the server measured
  → files.update(addParents, removeParents)   ← metadata change, not a byte copy
  → record the version
```

Promotion of a 4 GB file costs one HTTP request. That is the reason staging is a Drive *folder*
rather than a second Drive file.

### 1.2 The four properties that survive either backend

1. **Nothing is accepted before permission, type and quota are decided.** All of that is in
   `authorizeUpload`, above the interface; neither backend is reachable before it.
2. **Size and checksum are what the server measured.** Both backends hash in a passthrough over
   the bytes they actually received. `StagedContent` has no field a client-declared value could
   be written into.
3. **Unverified bytes are never at an address a download endpoint can resolve.** Every route
   resolves bytes through a `file_versions` row, and no row points into the staging folder until
   `promote` succeeds. A Drive id is not a capability.
4. **A failure leaves no half-file and no orphan record.** `discard` is idempotent, never throws
   for a missing object, and runs on every abandoned path.

## 2. Migration 0005 — and why the column could not be reused

`upload_sessions` had nowhere to hold the two handles the Drive path needs *between* requests:
the resumable session URI and the staged Drive file id. `receiveStream`/`receiveChunk` and
`finalize` are separate HTTP requests and neither handle is recomputable from the session id.

Overloading the existing nullable `quarantine_key` to carry a `drive:<id>` handle would have made
single-shot uploads work with no migration. Rejected: it makes one column mean two different
things depending on a flag, and the chunked path needs a *second* handle anyway, which pushes it
to encoding JSON in a string column.

`0005_upload_session_external_staging.sql` adds `external_upload_uri` and `external_staged_id`,
with matching Mongoose fields and a contract change. Both are null for a locally-staged upload.

## 3. Two divergences, both deliberate

### 3.1 A chunked upload pays one extra read for its checksum

A single-shot upload is hashed in the passthrough and costs nothing. A chunked one cannot be:
each chunk arrives in its own HTTP request, possibly on a different isolate, and a SHA-256 state
cannot be serialized between them. `assemble` therefore reads the staged object back from Drive
once.

The alternatives were worse in the same way each time. Trusting a client-supplied digest breaks
the rule that the checksum is what the *server* measured. Recording Drive's MD5 instead changes
what the column means and diverges from every other version in the database. Skipping
verification for large files inverts the risk — those are the uploads most worth verifying.

### 3.2 Drive staging has no pre-flight quota check

`assertHeadroom` succeeds unconditionally on the Drive backend. Google enforces the Shared
Drive's quota and reports an over-quota upload as a failure; there is no cheap query for
remaining space, and a check that always passes while looking like one that does not is worse
than an absent one. The local backend still checks the volume's free-space floor.

## 4. `UPLOAD_STAGING` is not `DEFAULT_STORAGE_PROVIDER`

They look interchangeable and are not, and the difference is the rollback plan.

* `DEFAULT_STORAGE_PROVIDER=google_drive` means *new content belongs in the Shared Drive*. The
  way it has always achieved that — write locally, scan, record, hand off, retain the local copy
  for `LOCAL_COPY_RETENTION_DAYS` — **is the rollback path for the whole byte migration.**
* `UPLOAD_STAGING=google_drive` is the separate, explicit decision to give that up. Bytes go
  straight into Drive and there is no local copy of anything uploaded that way.

Collapsing the two would have discarded the rollback path for every deployment that had already
turned Drive on, silently. On Node, Drive staging is opt-in and defaults to `local`.
`loadWorkerEnv` requires `google_drive` for both, as a `z.literal` rather than an enum with a
default: accepting `local` in a Worker and failing later turns one configuration mistake into a
run of failed uploads.

Asking for Drive staging while `GOOGLE_DRIVE_STORAGE_ENABLED=false` throws at selection time. It
does **not** fall back to local.

## 5. The health endpoint stops lying

`/api/health/ready` reported `storage.provider: "local"` because it called
`getStorageProvider()`. Cosmetic on Node; actively misleading on a Worker, and it is the first
line an operator reads after a deploy.

The writable-volume probe — write a file, read it back, delete it — is exactly the right check
for a mount that has silently become read-only, and an impossible one when there is no volume.
When staging is external the report says so and defers to the Drive connection check, which is
the dependency that actually gates uploads.

## 6. Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `tests/integration/upload-staged-in-drive.test.ts` | 6 passed |
| `tests/security/file-upload.test.ts` | 27 passed (one new: a chunked upload whose first chunk contradicts its extension) |

What the new suite asserts, in its own words:

* records the file as living in Drive, with the checksum the server measured
* leaves nothing in the staging folder once the upload is promoted
* refuses a mislabelled file before any of it is transferred
* removes the staged object when an upload is aborted
* assembles a chunked upload and survives a replayed chunk
* refuses to boot with Drive staging and local content recording

The replayed-chunk case is the one worth naming. A chunk request that timed out *after* Drive
committed it is indistinguishable from one that never arrived, and replaying at the wrong offset
corrupts the object. `receiveChunk` asks Drive for its own cursor before every send: bytes Drive
already holds are accepted as a no-op, and an offset that would leave a hole is refused.

## 7. Rollback

Delete `UPLOAD_STAGING` (or set it to `local`). Staging returns to the quarantine directory on
the next request — the value is read per call, not cached at startup. Migration 0005 adds two
nullable columns and needs no reversal; nothing reads them under local staging.

There is no rollback for *content already staged in Drive by a Worker*: it never had a local
copy. That is the trade recorded in §4, and it is why the setting is separate.
