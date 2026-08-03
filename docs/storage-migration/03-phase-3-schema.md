# Phase 3 — MongoDB schema extension

Status: **complete and verified**, including against a live database with pre-existing data.

Purely additive. No field removed, renamed or made required; no query rewritten; no service
touched. Nothing reads or writes these fields yet — Phase 4 onwards does that.

---

## 1. What was added

### Extended in place

| Model | Added |
|---|---|
| `FileVersion` | `storageProvider`, `googleDriveFileId`, `googleDriveParentId`, `googleDriveRevisionId`, `googleDriveMd5`, `googleDriveWebViewLink`, `migrationStatus`, `migratedAt`, `migrationFailureReason`, `syncStatus`, `lastSyncedAt`, `localCopyState`, `localCopyEligibleForDeletionAt`, `isGoogleNative`, `googleNativeKind` |
| `Folder` | `storageProvider`, `googleDriveFolderId`, `googleDriveParentFolderId`, `driveMappingStatus`, `driveMappedAt`, `syncStatus` |
| `File` | `storageProvider` (`local` \| `google_drive` \| **`mixed`**), `hasGoogleNativeContent` |

`File` gets **no Drive id**. It has never held a storage address, so a file listing cannot
leak one however carelessly it is serialized, and Phase 3 keeps that true. What it carries
is a category. `mixed` is the real and expected state of a file whose v1 is local and v2 is
in Drive.

The shared vocabulary lives in `src/server/db/storage-fields.ts`. **Every string in it is
persisted, so renaming one is a data migration, not a refactor.** `STORAGE_PROVIDERS` is
re-exported from the storage layer rather than redefined — two copies would let the database
and the provider registry drift into disagreeing.

### New collections

| Model | Collection | Purpose |
|---|---|---|
| `StorageMigrationJob` | `storagemigrationjobs` | One admin's decision: this selection, this mode |
| `StorageMigrationItem` | `storagemigrationitems` | One row per **version** — a 5-version file is 5 transfers |
| `StorageRecoveryItem` | `storagerecoveryitems` | The "Drive committed, MongoDB did not" queue |
| `DriveSyncState` | `drivesyncstates` | Drive change cursor (Phase 9; created now so Phase 9 is not another schema change) |

⚠ **These are not `MigrationJob`/`MigrationItem`.** Those already exist and are the *inbound*
Drive importer — read-only, opposite direction. See §3 of the Phase 0 analysis.

---

## 2. `storageKey` is never cleared, and that is the rollback plan

After migration a version holds **both** addresses: its original local key *and* its Drive
id. The local key stays `required` and `unique`.

That redundancy is deliberate and is the whole of §8's rollback story — reverting a version
to local storage is one field change with no data movement, and it only works while the
bytes are still there. It is also why `LOCAL_COPY_RETENTION_DAYS` exists and why
`DELETE_LOCAL_AFTER_MIGRATION` defaults to false.

---

## 3. The immutability hook — how far it was opened

`file-version.model.ts` throws on any update touching a path outside `MUTABLE_PATHS`. Every
Phase 3 field was outside it (Phase 0 risk **R3**), so the migration could not have written
one. It was invisible until the first write failed mid-run.

**Now mutable** — where the bytes are, and lifecycle:
`storageProvider`, all six `googleDrive*`, `migrationStatus`, `migratedAt`,
`migrationFailureReason`, `syncStatus`, `lastSyncedAt`, `localCopyState`,
`localCopyEligibleForDeletionAt`, `isGoogleNative`, `googleNativeKind`.

**Still immutable** — what the bytes *are*:
`checksumSha256`, `fileSize`, `mimeType`, `extension`, `originalFilename`, `versionNumber`,
`fileId`, `storageKey`, `storageArea`, `uploadedBy`.

> **Do not widen this further.** The hook exists so the bytes a reviewer approved cannot be
> swapped underneath the approval. Recording that the same bytes now also live in Drive does
> not touch that. A migration that could rewrite a checksum could hide a corrupt transfer by
> recording the corruption as expected — which would silently defeat every verification
> guarantee in the phase plan.

Each forbidden field has its own test.

---

## 4. Indexes — the guarantees are enforced, not promised

| Index | Why it is *unique* |
|---|---|
| `FileVersion.googleDriveFileId` (partial, `$type: 'string'`) | The hard stop on duplicate uploads. A retry recording a second Drive file for one version fails **at the database** — the layer still available when the worker has crashed. Partial, or every unmigrated version collides on null. |
| `Folder.googleDriveFolderId` (partial) | "Reuse the folder, never create a second" becomes an invariant. **No index on folder name** — matching by name would adopt a folder somebody made by hand. |
| `StorageMigrationItem.versionId` (partial on `claimActive`) | Two overlapping jobs cannot transfer one version. Only one could win the index above; the other leaves an orphan. |
| `StorageRecoveryItem.idempotencyKey` (partial on `status: 'open'`) | A retry finds the existing row instead of racing itself. |

`claimActive` is a maintained boolean rather than a status list so the partial filter keys on
a simple equality and cannot drift if the status vocabulary grows.

**Version note:** `$in` inside `partialFilterExpression` needs MongoDB **6.0+**. Production
pins `mongo:7`; verified empirically before the indexes were written, not assumed.

---

## 5. The migration script

```bash
npx tsx scripts/db/2026-08-01-storage-provider-fields.ts [--dry-run]
```

**No backfill, deliberately.** Mongoose applies a schema default on *read* for an absent
path, so a version written before Phase 3 already behaves as `local` / `not_started` /
`present` without being rewritten. Backfilling 100k documents to store values that are
already their defaults takes a long write lock, bloats the oplog and buys nothing. The
partial indexes key on `$type`/explicit values rather than on absence precisely so no query
depends on the field being present.

**No drops.** `createIndexes()` adds what is declared and missing. `syncIndexes()` would also
*drop* every live index not currently declared — a foot-gun aimed at production.

Idempotent, and proven so rather than claimed: run twice against the live database, the
second run reports `Nothing to do — all 54 declared indexes already exist`. A test asserts it.

---

## 6. Acceptance criteria

| Criterion | Evidence |
|---|---|
| Existing records remain valid | A document inserted through the raw driver with none of the fields reads back with every default — and is **still absent from disk** afterwards |
| Local files still work | A file created 2026-07-30 downloads (71 bytes), previews, ranges and lists versions in the running server |
| No approval or version relationship broken | Every content-identity field still rejects a write; 521 tests pass with no fixture change |
| Index creation succeeds | 19 created against live MongoDB 8.2 |
| `scripts/db/…` twice is a no-op | Verified live and in a test |
| `review-indexes.ts` reports nothing unexpected | Exit 0, "Every declared index exists" |
| Employees see none of it | DTO allow-list tests for both file and version DTOs; confirmed against real API responses |

---

## 7. Still open from Phase 0 — needed before Phase 5

Neither blocks Phase 4.

- **R1 — Shared Drive item limit (500,000, cannot be raised).** Every *version* is an item,
  and Phase 3 has now made the count queryable: `db.fileversions.countDocuments()` plus
  `db.folders.countDocuments()`. Above ~350,000 projected, `GOOGLE_SHARED_DRIVE_ID` must
  become a per-department mapping — cheap to design now, very expensive to retrofit.
- **R2 — folder depth.** Drive allows 20 levels, this application allows 32
  (`MAX_FOLDER_DEPTH`). Anything deeper than 19 is unmigratable as-is.
