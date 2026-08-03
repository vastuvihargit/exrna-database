# Phase 0 — Audit and Migration Design

**Local server storage → Google Shared Drive storage**
**Status: analysis only. No production code changed.**

This document is the authority for the whole migration. Phases 1–11 are executed against it.

---

## 1. Current storage architecture

### 1.1 Shape

```
Browser ──► Next.js route handler ──► service ──► repository ──► MongoDB
                                        │
                                        └──► getStorageProvider() ──► LocalStorageProvider ──► disk
```

MongoDB holds every piece of application state. The filesystem holds bytes and nothing else.

### 1.2 The single most important existing fact

**`File` does not know where its bytes are.** It has no storage key, no path, no area.
Only `FileVersion` does:

| Field | Purpose |
|---|---|
| `storageKey` | provider-scoped relative key, **unique index** |
| `storageArea` | one of 8 logical areas |
| `relativeStoragePath` | `area/key`, diagnostics only |
| `storedFilename` | generated UUID |

All four are in the global `ALWAYS_HIDDEN` list (`base-schema`) and are additionally omitted by the DTO layer. Two independent barriers stop a physical path reaching a browser.

**Consequence for this migration:** the storage-provider fields belong on `FileVersion`, not on `File`. The example record in the brief (`§5`) puts `googleDriveFileId` on the file document; doing that here would break the design that keeps physical location out of file listings, and would be wrong for a file with five versions spread across two providers. `File` gets *denormalized read-only mirrors* only (see §5).

### 1.3 Storage areas

`originals · versions · previews · quarantine · migration-staging · temporary · exports · archives`

Only **`originals`** holds durable file content. Everything else is transient, derived, or serves the inbound importer.

**Design decision (D1): only `originals` moves to Google Drive.**
`quarantine`, `temporary`, `previews`, `exports` stay on local disk permanently. Rationale in §9.1.

### 1.4 Folders have no filesystem representation

`Folder` is a pure MongoDB tree (`parentFolderId` + materialized `pathAncestors`). Creating, renaming, moving or trashing a folder currently performs **zero** storage operations.

**Consequence:** Drive folder mirroring is net-new behaviour, not a refactor. It is the single largest source of new failure modes in this project, because it adds a remote call to six operations that are currently pure database writes and cannot fail halfway.

### 1.5 Key construction

`src/server/storage/keys.ts` — physical names are always generated identifiers (`randomUUID`, ObjectId hex), never a user's filename. A key can never carry a separator, an extension, or an attacker-chosen string.

```
originals/{organizationId}/{departmentId}/{fileId}/{versionId}
quarantine/{uploadSessionId}/assembled
temporary/{uploadSessionId}/part-000123
```

### 1.6 Guarantees the local provider enforces today

These are load-bearing and every one of them must be re-established, weakened deliberately, or explicitly declared not-applicable for Drive:

| # | Guarantee | Where | Drive status |
|---|---|---|---|
| G1 | No overwrite ever (`wx` exclusive create) | `local-provider.ts:127` | **Not native.** Drive happily creates duplicate names. Re-established via app-side idempotency key (§7.4). |
| G2 | Size and SHA-256 measured while streaming, never trusted from client | `local-provider.ts:112–124` | Preserved — hashing happens during quarantine write, before Drive is involved. |
| G3 | Nothing buffered in memory | throughout | Must be preserved via Drive **resumable** upload with a streamed body. |
| G4 | Every key validated before syscall | `path-safety.ts` | N/A — Drive uses opaque IDs. Replaced by "the ID came from our own DB". |
| G5 | Only regular files read (symlink TOCTOU closed) | `local-provider.ts:223–235` | N/A. |
| G6 | fsync before success is reported | `local-provider.ts:151` | Replaced by "Drive returned 200 with a fileId and a matching md5". |
| G7 | Versions immutable — schema hook blocks non-whitelisted updates | `file-version.model.ts:88–129` | **Active blocker — see §5.3.** |

---

## 2. Exact places local storage is used

`getStorageProvider()` appears in **8 modules only**. This is unusually well-contained and is why the migration is feasible without rewriting the application.

| File | Lines | What it does | Phase |
|---|---|---|---|
| `src/server/bootstrap.ts` | 5, 26, 30 | `ensureReady()` at boot; reports provider name in the boot log | 2 |
| `src/server/health/health-service.ts` | 12, 39 | capacity + writability probe | 2 |
| `src/server/services/upload.service.ts` | 213, 259, 341, 657, 701, 731, 768, 779 | quarantine write, chunk write, finalize move, headroom, signature head-read, chunk assembly, chunk cleanup, discard | 6 |
| `src/server/services/download.service.ts` | 170 | `getFile` for preview **and** download | 4 |
| `src/server/services/version.service.ts` | 55 | `fileExists` + `copyFile` for version restore | 7 |
| `src/server/services/file.service.ts` | 341, 753 | `copyFile` for file copy; `deleteFile` in trash purge | 7 |
| `src/server/services/integrity.service.ts` | 69, 216 | orphan sweep (`listKeys`), checksum re-verification | 4 |
| `src/server/services/migration.service.ts` | 672, 1098 | **inbound** Drive→local importer staging | — (unchanged) |
| `src/server/services/system.service.ts` | 28, 79 | admin storage panel | 2 |

**The read chokepoint** is `versionRepository.getStorageLocation(versionId)`
(`file-version.repository.ts:120`). Every read path — download, preview, restore, integrity — funnels through it. Extending its return type with `provider` and `externalId` is what makes dual-storage reads a ~40-line change instead of a rewrite.

**The write chokepoint** is `upload.service.ts:412` (`storage.moveFile(quarantine → originals)`). One call site decides where new bytes land.

Direct `fs` usage outside `src/server/storage/**` is **zero**, and `tests/unit/architecture-boundaries.test.ts:46` fails the build if that changes. The Drive code must live inside `src/server/storage/**` or that guard has to be widened — it should not be widened.

---

## 3. ⚠ Naming collision: two different things are called "migration"

This project **already has** a feature called migration, and it runs in the opposite direction.

| | Existing (shipped) | New (this project) |
|---|---|---|
| Direction | Google Drive → this platform | this platform → Google Shared Drive |
| Purpose | one-time ingest of legacy company Drive content | permanent storage backend |
| OAuth scope | `drive.readonly` — **write is structurally impossible** (`google-drive-client.ts` hard-codes `method: 'GET'`) | `drive` (read/write) |
| Auth | interactive admin OAuth, refresh token encrypted per job | service account (§4) |
| Models | `MigrationJob`, `MigrationItem` | must **not** reuse these |
| Service | `migration.service.ts` (1145 lines) | new |
| Client | `src/server/migration/google-drive-client.ts` | new, separate |
| Admin UI | `/admin/migrations` | new |
| Tests | `tests/security/google-drive-migration.test.ts` | new |

**Decision (D2): strict namespace separation.**

| Concern | Existing | New |
|---|---|---|
| Model | `MigrationJob` / `MigrationItem` | `StorageMigrationJob` / `StorageMigrationItem` |
| Collection | `migrationjobs` | `storagemigrationjobs` |
| Server dir | `src/server/migration/` | `src/server/storage/google/` |
| Service | `migration.service.ts` | `storage-migration.service.ts` |
| Admin route | `/admin/migrations` | `/admin/storage-migration` |
| Env prefix | `GOOGLE_DRIVE_REDIRECT_URI` | `GOOGLE_DRIVE_STORAGE_*` |

Reusing the existing models would put a write-capable, whole-organization storage backend inside a collection whose documents are keyed `(jobId, driveFileId)` for an inbound importer. The two would corrupt each other's counters and their audit trails would be indistinguishable.

**Cosmetic follow-up (Phase 11, optional):** relabel the existing admin page "Import from Google Drive" so the two are distinguishable to an administrator. Code names stay.

---

## 4. Google authentication design

### 4.1 Selected method: **service account as a direct member of the Shared Drive**

Add the service account's email as a **Content Manager** on the company Shared Drive. No domain-wide delegation. No interactive OAuth.

### 4.2 Why, and why not the alternatives

**Rejected — domain-wide delegation.** DWD grants the key the ability to impersonate *any user in the Workspace domain* across the granted scopes. That key would sit in an application-server environment variable. A single leak is a full-domain compromise, not a Drive compromise. It also requires Super Admin authorization and is unnecessary: Shared Drives accept service accounts as members directly. Nothing in §2–§19 of the brief needs impersonation, because §13 states the application's MongoDB permission model is authoritative and employees do not need direct Drive access.

**Rejected — admin-authorized OAuth connection.** This is what the *existing inbound importer* uses, correctly, because that job is interactive, temporary and bounded. It is wrong for a permanent storage backend: refresh tokens are revoked when the granting admin's password changes, when their session is reset, when they leave the company, or after 6 months of non-use on an unverified app. The failure mode is "all uploads and downloads stop, company-wide, on a Tuesday, because someone left". A service-account key has no such lifecycle.

**Selected — service account membership.** Properties:

- Files it creates in a Shared Drive are **owned by the Shared Drive** (the organization), never by an individual. This satisfies "do not use an employee's personal My Drive" structurally, not by policy.
- Service accounts have **no Drive storage quota of their own**; consumption is charged to the Shared Drive against pooled Workspace storage. A service account writing to *My Drive* would fail on quota — another reason Shared Drive is not optional here.
- Access is revocable in one click by removing the member, with no code change.
- Scope is `https://www.googleapis.com/auth/drive`, but *effective* reach is bounded by Shared Drive membership: the account can see exactly one Shared Drive and nothing else in the domain.

### 4.3 Security implications, stated plainly

| Implication | Mitigation |
|---|---|
| The private key is a bearer credential for all company research files. | Mount as a file secret (Docker secret / K8s secret), not a `.env` line, in production. `GOOGLE_DRIVE_STORAGE_PRIVATE_KEY_FILE` takes precedence over the inline variable. Never logged; redacted in the logger's serializer allow-list. |
| Key compromise = full read/write of the Shared Drive. | Documented 90-day rotation with two-key overlap; removal of the member revokes instantly; Drive admin audit log retains every action taken by the SA email. |
| One identity performs every write, so Drive-native "last modified by" is meaningless. | The application audit log is and remains the authoritative attribution. Every Drive mutation is preceded by an audit entry naming the real actor. Stated in the admin guide so nobody misreads the Drive activity pane. |
| A bug in application permission checks is no longer contained by filesystem permissions. | Unchanged from today in practice (the app already runs as one Unix user), but the Drive call must never be reachable without passing `requireFile` / `requireFolder`. Enforced by keeping all Drive calls behind the provider and all provider calls behind services. |
| Credentials must never reach the browser. | Structural: the provider module imports `server-only`; the architecture-boundaries test already fails any `@/server/storage` import from `components/` or `hooks/`. Add an explicit assertion that no `GOOGLE_DRIVE_STORAGE_*` variable appears in `public-env.ts`. |

### 4.4 Environment configuration

The brief's proposed names collide with variables that already exist for two other features. Namespaced instead:

```env
# ── EXISTING, unchanged ────────────────────────────────────────────
GOOGLE_CLIENT_ID=                 # employee sign-in (OAuth)
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=              # sign-in callback
GOOGLE_DRIVE_REDIRECT_URI=        # INBOUND importer callback — not storage

# ── NEW: Google Shared Drive as a storage backend ──────────────────
GOOGLE_DRIVE_STORAGE_ENABLED=false
DEFAULT_STORAGE_PROVIDER=local            # local | google_drive

GOOGLE_WORKSPACE_DOMAIN=company.com
GOOGLE_SHARED_DRIVE_ID=
GOOGLE_DRIVE_ROOT_FOLDER_ID=              # folder inside the Shared Drive; blank = drive root

GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY=       # dev only; \n-escaped PEM
GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE=  # production; path to mounted secret

GOOGLE_DRIVE_UPLOAD_CHUNK_MB=16           # resumable session chunk
GOOGLE_DRIVE_MAX_CONCURRENT_TRANSFERS=4
GOOGLE_DRIVE_REQUEST_TIMEOUT_MS=120000

# ── Local copy retention ───────────────────────────────────────────
LOCAL_COPY_RETENTION_DAYS=30
DELETE_LOCAL_AFTER_MIGRATION=false
```

**Boot-time refusals** (added to `env.ts` `superRefine`, matching the existing fail-fast style):

- `DEFAULT_STORAGE_PROVIDER=google_drive` while `GOOGLE_DRIVE_STORAGE_ENABLED=false` → refuse to boot.
- `GOOGLE_DRIVE_STORAGE_ENABLED=true` without `GOOGLE_SHARED_DRIVE_ID` or without a key source → refuse to boot.
- `DELETE_LOCAL_AFTER_MIGRATION=true` while `LOCAL_COPY_RETENTION_DAYS=0` → refuse to boot.
- Production + `GOOGLE_DRIVE_STORAGE_ENABLED=true` + inline `PRIVATE_KEY` (not `_FILE`) → warn loudly in the boot log and on the admin system page.

### 4.5 Library choice

Add **`google-auth-library`** only (official, small, handles RS256 JWT assertion, token caching, refresh, and clock skew). Drive REST calls stay hand-written `fetch`, matching the existing `google-drive-client.ts` style. The full `googleapis` package is ~50 MB of generated surface for the ~12 endpoints needed and would be the largest dependency in the tree.

---

## 5. MongoDB schema changes

All changes are **additive**. No field is removed, renamed, or made required. Existing documents remain valid with no backfill — absent `storageProvider` means `local` at every read site.

### 5.1 `FileVersion` — where the real change lands

```ts
storageProvider: { type: String, enum: ['local','google_drive'], default: 'local' },

// Google Drive location. Sparse — absent on every existing row.
googleDriveFileId:     { type: String, default: null, maxlength: 200 },
googleDriveParentId:   { type: String, default: null, maxlength: 200 },
googleDriveRevisionId: { type: String, default: null, maxlength: 200 },
googleDriveMd5:        { type: String, default: null, maxlength: 32 },
googleDriveWebViewLink:{ type: String, default: null, maxlength: 1000 },

migrationStatus: { type: String, enum: MIGRATION_STATUSES, default: 'not_started' },
syncStatus:      { type: String, enum: SYNC_STATUSES,      default: 'not_required' },
lastSyncedAt:    { type: Date, default: null },
migratedAt:      { type: Date, default: null },

// Local copy retention
localCopyState: { type: String, enum: ['present','archived','deleted'], default: 'present' },
localCopyEligibleForDeletionAt: { type: Date, default: null },

// Google-native documents (§11)
isGoogleNative:  { type: Boolean, default: false },
googleNativeKind:{ type: String, enum: ['document','spreadsheet','presentation'], default: null },
```

**`storageKey` stays required and unique, and is never cleared.** After migration a version has *both* a local key and a Drive ID. This is deliberate and is the entire rollback mechanism (§8): reverting a version to local storage is a single field flip with no data movement.

**`isGoogleNative` versions are the one exception** — they have no local bytes ever. They get a synthetic `storageKey` of `gnative/{versionId}` so the unique index and the `required` constraint hold without a special case anywhere else.

### 5.2 Indexes on `FileVersion`

```ts
{ googleDriveFileId: 1 }   unique, partial: { googleDriveFileId: { $type: 'string' } }
{ storageProvider: 1, migrationStatus: 1, _id: 1 }     // migration worker cursor
{ syncStatus: 1, lastSyncedAt: 1 }   partial: syncStatus ≠ 'not_required'
{ localCopyState: 1, localCopyEligibleForDeletionAt: 1 } partial: localCopyState = 'present'
```

The unique partial index on `googleDriveFileId` is the **hard guarantee against duplicate uploads on retry** (§7.4). It is not advisory; a retry that would create a second Drive file for a migrated version fails at the database.

### 5.3 ⚠ Blocker: the version immutability hook

`file-version.model.ts:88` defines `MUTABLE_PATHS`. Any `updateOne`/`updateMany`/`findOneAndUpdate` touching a path outside that set **throws**. Every new field above is outside it, so the migration cannot write a single one without a change here.

**Decision (D3):** extend `MUTABLE_PATHS` with the storage-location and lifecycle fields **only**, and keep the content-identity fields (`checksumSha256`, `fileSize`, `mimeType`, `extension`, `originalFilename`, `versionNumber`, `fileId`, `storageKey`) immutable exactly as they are today.

That preserves the property the hook exists to protect — *the bytes a reviewer approved cannot be swapped* — while allowing "the same bytes now also live over there" to be recorded. The distinction is written into the comment block so a future reader does not widen it further.

### 5.4 `Folder`

```ts
storageProvider:            { type: String, enum: ['local','google_drive'], default: 'local' },
googleDriveFolderId:        { type: String, default: null, maxlength: 200 },
googleDriveParentFolderId:  { type: String, default: null, maxlength: 200 },
driveMappingStatus: { type: String, enum: ['none','creating','mapped','failed'], default: 'none' },
driveMappedAt:      { type: Date, default: null },
syncStatus:         { type: String, enum: SYNC_STATUSES, default: 'not_required' },
```

Index: `{ googleDriveFolderId: 1 }` unique, partial on `$type: 'string'`.

The unique index is what makes "reuse the existing Drive folder, never create a second one" (§8 of the brief) an enforced invariant rather than a code convention. **Folders are never matched by name** — only through this stored mapping.

### 5.5 `File` — read-only mirrors, for listings only

```ts
storageProvider: { type: String, enum: ['local','google_drive','mixed'], default: 'local' },
hasGoogleNativeContent: { type: Boolean, default: false },
```

Mirrors of the current version's provider, maintained by the same writes that set `currentVersionId`. Used for the admin dashboard and for the "open in Google editor" affordance. **No Drive ID is ever stored on `File`**, preserving §1.2.

`'mixed'` covers the real and expected state of a file whose v1 is local and v2 is on Drive.

### 5.6 New collections

**`StorageMigrationJob`** — selection criteria (folder / department / project / fileType / dateRange / explicit version IDs), mode (`dry_run` | `migrate` | `verify_only` | `rollback`), status, counters (selected/uploaded/verified/failed/skipped/bytes), pause flag, throughput samples, actor, timestamps.

**`StorageMigrationItem`** — one row per **version** (not per file: a 5-version file is 5 transfers).
Unique index `{ jobId: 1, versionId: 1 }`.
Additional unique partial index `{ versionId: 1 }` on `status ∈ {uploading, uploaded, verifying}` so two concurrent jobs cannot transfer the same version.

**`DriveSyncState`** — one document per Shared Drive: `startPageToken`, `lastPollAt`, `lastError`, `consecutiveFailures`. Phase 9 only.

**`StorageRecoveryItem`** — the §16 reconciliation queue: "bytes reached Drive but MongoDB did not commit". Holds `versionId`, `idempotencyKey`, `observedDriveFileId`, `phase`, `resolvedAt`. Written *before* the Drive call, cleared after the Mongo commit.

### 5.7 Backward-compatible database migration

A script, not a schema default rewrite:

```
scripts/db/2026-xx-storage-provider-fields.ts
```

1. `createIndexes()` with `background: true` for every new index.
2. **No `updateMany` backfill.** Mongoose applies `default: 'local'` on read for absent paths, and every query written in Phase 3 uses `{ $in: ['local', null] }` / `$exists` semantics rather than `= 'local'`. Backfilling 100k documents to write a value that is already the default buys nothing and takes a write lock.
3. Idempotent: safe to run repeatedly, verified by running it twice in CI.

---

## 6. Storage-provider design

### 6.1 The existing interface is kept

The brief proposes an interface (`uploadFile`/`downloadFile`/`createFolder`/`moveItem`/`trashItem`/…). The codebase already has one, and it is a *different* abstraction: key+area, immutable, no folders, range reads, incremental write handles, capacity, key listing.

**Decision (D4): do not replace `StorageProvider`. Extend it.**

Replacing it would rewrite `upload.service.ts` end to end — the chunk assembler, the quarantine flow, the signature head-read, the malware scan — to gain nothing, because the operations the brief's interface adds (`createFolder`, `renameItem`, `moveItem`, `trashItem`) are operations the *local* provider has never needed and never will. They are Drive-mirroring concerns, and they belong in a second, separate interface.

### 6.2 Two interfaces, one registry

```ts
// Unchanged. Local implements it fully; Drive implements it for `originals` only.
interface StorageProvider { saveFile, getFile, deleteFile, fileExists, moveFile,
                            copyFile, getFileMetadata, createWriteStream,
                            listKeys, getCapacity, ensureReady }

// New. Only the Drive provider implements it; local returns a no-op mirror.
interface HierarchicalStorageProvider {
  ensureFolder(input: EnsureFolderInput): Promise<StoredFolderResult>;
  renameItem(externalId: string, name: string): Promise<void>;
  moveItem(externalId: string, newParentExternalId: string, oldParentExternalId: string): Promise<void>;
  trashItem(externalId: string): Promise<void>;
  restoreItem(externalId: string): Promise<void>;
  deleteItem(externalId: string): Promise<void>;
  copyItem(externalId: string, targetParentExternalId: string, name: string): Promise<StoredFileResult>;
  itemExists(externalId: string): Promise<boolean>;
}
```

`LocalStorageProvider` gets a `HierarchicalStorageProvider` implementation whose methods are **no-ops that return success** — because a local folder genuinely has no storage-side existence today, and pretending otherwise would invent state that nothing reads. This keeps every call site provider-agnostic with no `if (provider === 'local')` branches leaking upward.

### 6.3 The locator

The change that makes dual-storage work:

```ts
interface StorageLocator {
  provider: 'local' | 'google_drive';
  key: string;              // always present; local key, retained after migration
  area: StorageArea;
  externalId?: string;      // Drive file ID
  externalRevisionId?: string;
}
```

`versionRepository.getStorageLocation()` returns this instead of `{key, area, …}`. Every existing caller keeps compiling because `key` and `area` are still there.

```ts
const provider = storageRegistry.resolve(location.provider);
const body = await provider.getFile(location, range);
```

The Drive provider ignores `key`/`area` on reads and uses `externalId`; the local provider ignores `externalId`. Neither branches on the other's fields.

### 6.4 Boundaries

- Providers receive **no `Actor`, no permission context, no Mongoose model**. Authorization stays entirely in services, exactly as it is today.
- One Drive client (`src/server/storage/google/drive-client.ts`); no route, service or repository ever calls `fetch('https://www.googleapis.com/drive/…')`.
- Providers are constructor-injected and `setStorageProvider()` already exists as a test seam. An `InMemoryDriveStub` implementing the two interfaces makes every Phase 5–9 test runnable without a Google account — matching how the inbound importer is already tested against `DriveReader`.
- The Drive code lives under `src/server/storage/`, so `architecture-boundaries.test.ts` needs **no** widening.

---

## 7. Migration flow for existing local files

### 7.1 Unit of work: the **version**, not the file

A file with 5 versions is 5 transfers, sharing one Drive parent folder. Migrating only the current version would silently make version history unrecoverable after local deletion.

### 7.2 Flow

```
select versions (batch, ordered by _id for a stable cursor)
   ↓ claim item atomically: status pending → uploading, guarded by unique partial index
   ↓ read FileVersion + parent File + Folder chain
   ↓ local file exists?            no → status=failed, reason=LOCAL_MISSING, file stays usable? no → flag for admin
   ↓ recompute SHA-256 from disk   mismatch vs stored → failed, reason=LOCAL_CORRUPT, never uploaded
   ↓ ensureDriveFolderPath(folder) → walks pathAncestors root→leaf, creates missing, records mapping
   ↓ write StorageRecoveryItem { versionId, idempotencyKey }        ← BEFORE any Drive write
   ↓ Drive resumable upload, streamed from disk, MD5 computed in the same pass
   ↓ read back files.get(fileId, fields=id,name,size,md5Checksum,headRevisionId,webViewLink)
   ↓ verify: size == stored fileSize  AND  md5 == locally computed md5
   ↓        mismatch → delete the Drive file, status=failed, reason=VERIFY_MISMATCH
   ↓ update FileVersion { storageProvider: 'google_drive', googleDrive*, migrationStatus: 'verified',
                          localCopyEligibleForDeletionAt: now + LOCAL_COPY_RETENTION_DAYS }
   ↓ clear StorageRecoveryItem
   ↓ audit entry
   ↓ LOCAL COPY UNTOUCHED
```

### 7.3 Verification uses MD5, not SHA-256

Drive exposes `md5Checksum` for uploaded binary content and does not expose SHA-256. Verifying by re-downloading and re-hashing would double the transfer cost of the entire migration.

**Decision (D5):** compute MD5 **and** SHA-256 in the same streaming pass off local disk. SHA-256 confirms the local file still matches what MongoDB recorded (catches local bit-rot before it is propagated). MD5 is compared against Drive's own value (confirms the round trip). Both must pass. The MD5 is stored in `googleDriveMd5` so a later verify-only run needs one metadata call and no bytes.

Google-native files have no `md5Checksum`; they are verified by `headRevisionId` presence and are never a *migration* target anyway (they can only be created in Drive, §11).

### 7.4 Idempotency and duplicate prevention — four independent layers

1. **Atomic claim.** `findOneAndUpdate({ _id, status: 'pending' }, { status: 'uploading' })` — a second worker gets `null` and moves on.
2. **Unique partial index** on `FileVersion.googleDriveFileId` — a second successful upload for the same version cannot be recorded.
3. **Pre-flight check.** If `migrationStatus ∈ {uploaded, verified}` and `googleDriveFileId` is set, `files.get` it; if it exists, jump straight to verification. A retry after a lost response never re-uploads.
4. **`appProperties.idempotencyKey`** written onto every Drive file at creation. Recovery scans `files.list(q: appProperties has key = X)` to find an orphan from a crashed run and adopt it rather than uploading again.

Layer 4 is what closes the genuinely hard case: the process dies *after* Drive commits and *before* MongoDB does. `StorageRecoveryItem` says which key to look for.

### 7.5 Modes

| Mode | Reads local | Writes Drive | Writes Mongo |
|---|---|---|---|
| `dry_run` | yes (existence + checksum) | no | items only, `status=would_migrate` |
| `migrate` | yes | yes | yes |
| `verify_only` | no | metadata reads | `migrationStatus` only |
| `rollback` | no | no (Drive file left in place) | flips `storageProvider` back to `local`, `migrationStatus='rolled_back'` |

### 7.6 Throughput and quota control

- `GOOGLE_DRIVE_MAX_CONCURRENT_TRANSFERS` (default 4) bounds parallelism.
- Exponential backoff with jitter on `403 rateLimitExceeded`, `403 userRateLimitExceeded`, `429`, `5xx`. Drive's default project quota is 12,000 requests / 60s; a single migration must never be able to exhaust it, because interactive uploads and downloads share it.
- Migration workers run at lower effective priority: a `429` pauses the migration for a cooldown window rather than retrying tightly, so employees' interactive traffic wins.

### 7.7 Admin dashboard (`/admin/storage-migration`)

Selected · total bytes · uploaded · verified · failed · skipped · remaining · MB/s (60s rolling) · ETA · failure reasons grouped by code with counts · per-item table with retry · pause/resume · dry-run report download.

---

## 8. Rollback plan

**Rollback is a field flip. No data is moved.**

This is a direct consequence of D-decision "`storageKey` is never cleared" (§5.1). Local bytes remain in place, untouched, for `LOCAL_COPY_RETENTION_DAYS`.

| Level | Action | Time | Data risk |
|---|---|---|---|
| **L0 — single version** | admin action → `storageProvider='local'`, `migrationStatus='rolled_back'` | seconds | none |
| **L1 — one job** | rollback mode over the job's items | minutes | none |
| **L2 — all new uploads** | `DEFAULT_STORAGE_PROVIDER=local`, restart | one deploy | none; already-migrated files keep reading from Drive |
| **L3 — full disable** | `GOOGLE_DRIVE_STORAGE_ENABLED=false` + bulk rollback of every `verified` version | hours | none, *provided local copies were not deleted* |
| **L4 — after local deletion** | restore from backup, then L3 | hours–days | **real** |

L4 is why `DELETE_LOCAL_AFTER_MIGRATION` defaults to `false`, why deletion is a separate explicitly-approved admin action, and why Phase 11 is gated on a tested restore drill.

**Rollback is untestable in theory and must be exercised**: Phase 5 acceptance requires an actual L1 rollback of a migrated test project, followed by a successful download of every file in it.

---

## 9. Design decisions with material trade-offs

### 9.1 D1 — uploads stage through local quarantine; only verified bytes reach Drive

The brief's §9 flow reads "create upload session → upload to Google Shared Drive". Implemented literally, that would put unscanned, unverified bytes into company storage.

Today the pipeline is:

```
browser → quarantine (local) → measure size+SHA-256 → magic-byte signature check
        → malware scan → move to originals
```

The signature check and the malware scan both **read the bytes back** before the file is trusted. If Drive is the landing zone, an infected file exists at a real Drive ID — visible in the Drive web UI, syncable to desktops, indexable — during the scan window.

**Decision:** quarantine and chunk assembly stay local, permanently. `finalize()` uploads the verified object to Drive instead of `moveFile`-ing it to `originals`.

| Cost | Assessment |
|---|---|
| Bytes traverse the server twice (in, then out) | Accepted. Finalize gets slower for large files. |
| Local disk still needs headroom | Yes — sized for *concurrent in-flight uploads*, not total corpus. `assertDiskHeadroom` is re-pointed at the quarantine volume; the `MIN_FREE_DISK_GB` floor stops meaning "we are out of storage" and starts meaning "we cannot accept uploads right now". Admin dashboard copy changes accordingly. |
| A 2 GB upload's "Saving…" step can take minutes | **This is the one visible UX change.** Mitigation in §9.2. |

The alternative — scanning after the file is in Drive — was rejected. It converts a structural guarantee into a race.

### 9.2 D6 — finalize becomes asynchronous for large files

Because of D1, `POST /api/uploads/:id/finalize` would block for the whole server→Drive transfer. Next.js `maxDuration` is 300 s; a 2 GB file over a modest uplink exceeds that.

**Decision:** above a threshold (default 100 MB), `finalize` returns immediately with `status: 'saving'` after claiming the session, and a background transfer completes it. The existing upload tray already polls `GET /api/uploads/:sessionId`; it gains one state.

User-facing states map to the brief's §9 vocabulary exactly: *Preparing · Uploading · Saving · Complete · Upload failed · Try again*. No Google terminology appears.

Below the threshold, finalize stays synchronous and the flow is indistinguishable from today.

### 9.3 D7 — folder mirroring is lazy, not eager

Drive folders are created **on demand**, the first time content needs to land in one, walking `pathAncestors` root→leaf. Empty application folders get no Drive counterpart until they hold something.

Why: eager creation means every `POST /api/folders` gains a remote call that can fail, turning a pure, fast, transactional database write into a distributed operation. It would also create tens of thousands of empty Drive folders and consume the Shared Drive item limit for nothing.

`ensureFolderPath` is idempotent and guarded by the unique index on `googleDriveFolderId`; concurrent uploads into the same new folder produce one Drive folder, not two.

The migration tool offers an *optional* eager pre-create pass for administrators who want the Drive tree to look complete.

### 9.4 D8 — Drive is never consulted to render a page

Unchanged from the brief's §12, and worth recording as a decision because it is easy to erode: My Drive, Recent, Starred, Search, Trash, project and department views are pure MongoDB queries. Drive is touched only by upload, download, preview, mutation mirroring, migration and sync. A listing of 200 files must remain 1 database query and 0 Drive calls.

---

## 10. Risk assessment

Ordered by expected damage.

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Shared Drive 500,000-item hard limit.** Every file version is an item. A 60k-file corpus averaging 3 versions is 180k items *plus* folders. There is no way to raise it. | Medium | **Fatal** — migration stops permanently partway. | **Phase 0 gate: count `FileVersion` + `Folder` documents before Phase 5 starts.** If projected items exceed ~350k, the design must shard across multiple Shared Drives, which changes `GOOGLE_SHARED_DRIVE_ID` from a scalar to a per-department mapping. Cheap to design now, very expensive to retrofit. |
| R2 | **Folder depth: Drive allows 20 levels; `MAX_FOLDER_DEPTH` is 32.** | Medium | High — deep folders silently unmigratable. | Dry-run reports any folder with `depth > 19` before anything is written. Either flatten those trees or lower `MAX_FOLDER_DEPTH` to 20 for new folders. **Must be decided before Phase 5.** |
| R3 | Version-immutability hook blocks all storage-field writes (§5.3). | Certain | High if found late | Handled in Phase 3 by a scoped `MUTABLE_PATHS` extension. Listed here because it is invisible until the first write fails. |
| R4 | Drive succeeds, MongoDB fails → orphan Drive file, user told "failed". | Medium | Medium | `StorageRecoveryItem` written before the Drive call + `appProperties.idempotencyKey` + a reconciliation sweep. Never reported as success. |
| R5 | MongoDB succeeds, Drive fails → record points at nothing. | Medium | High | Drive call always precedes the Mongo commit for creates. For mutations (rename/move/trash), Drive first, then Mongo; a Drive failure aborts the whole operation and the user sees a plain failure. |
| R6 | Drive API quota exhausted by migration, blocking employee uploads. | Medium | High | Bounded concurrency, backoff, migration yields to interactive traffic on 429, admin-visible quota panel. |
| R7 | Download bandwidth: every byte now transits the app server twice (Drive→server→browser). | Certain | Medium | Measured in Phase 4 against a real 500 MB file. If unacceptable, the fallback is short-lived signed Drive links — but that violates §10 ("browser must not access Drive directly") and needs an explicit decision, not a quiet one. |
| R8 | Employee-visible latency on preview/download increases. | Certain | Low–Medium | Range requests still work (`alt=media` honours `Range`). Preview of already-generated thumbnails stays local and unaffected. |
| R9 | Someone renames/moves/deletes files directly in the Drive web UI. | High (it is a Shared Drive) | Medium | Phase 9 sync. Until Phase 9 ships, restrict Shared Drive membership to the service account + 2 named administrators. **Do not grant employees Drive access before sync exists.** |
| R10 | Drive file missing at read time (deleted directly, or purged from Drive trash after 30 days). | Medium | High | Never delete the MongoDB record. Mark `syncStatus='conflict'`, serve from the retained local copy if present, notify admin, preserve audit history. |
| R11 | Service-account key leak. | Low | **Severe** | §4.3. |
| R12 | Confusion between the inbound importer and the outbound storage migration by an operator. | High | Medium | §3 namespace separation + distinct admin pages + distinct audit action prefixes (`migration.*` vs `storage_migration.*`). |
| R13 | Quota semantics drift: user/department quotas are enforced against numbers MongoDB maintains, while real consumption moves to pooled Workspace storage. | Certain | Low | Documented. Admin system page grows a "Shared Drive usage" figure read from `drives.get(fields=…)` / Admin SDK, alongside the existing local figures. |
| R14 | Approved Google-native document edited in Drive → approval silently stale. | Medium | High (compliance) | §11 of the brief: approval binds `googleDriveRevisionId`. Phase 8 change detection flips the file back to `changes_requested` and notifies. |

---

## 11. Test plan

New suites, following the existing `tests/unit` + `tests/security` layout.

**Unit** — `google-drive-provider.test.ts` (against a stub client), `storage-registry.test.ts`, `storage-locator.test.ts`, `drive-folder-mapping.test.ts`, `storage-migration-planner.test.ts`, `drive-backoff.test.ts`.

**Integration (mongodb-memory-server + Drive stub)** — dual-provider read, dry run, successful migration, failed migration leaves the version local and readable, retry does not duplicate, checksum mismatch aborts and deletes the Drive object, rollback restores local reads, concurrent claim of one version, upload to Drive, resumable upload of a large stream, rename/move/trash/restore mirroring, version restore across providers, approval invalidation on native-document change.

**Security (extends the existing suites)** — permission enforcement unchanged for Drive-backed files; ID guessing reaches nothing; no Drive ID, storage key, provider name or checksum appears in any employee-facing DTO (assert against the serialized response, not the model); search leaks nothing across providers; the `GOOGLE_DRIVE_STORAGE_*` variables never appear in `public-env.ts`; partial Google API failure never yields a success response.

**Failure injection** — Mongo fails after Drive success; Drive fails after Mongo prepare; expired sync token; Drive file missing at read; 429 storm.

**Every phase runs:** `npm run typecheck && npm run lint && npm test && npm run build`.

---

## 12. Phase acceptance criteria (project-specific additions)

The brief's criteria are adopted in full. These are added because they are specific to what this codebase actually guarantees:

| Phase | Additional acceptance criteria |
|---|---|
| 1 | `architecture-boundaries.test.ts` still passes unwidened. `tests/unit/local-storage-provider.test.ts` and `storage-keys.test.ts` pass unmodified. No change to any DTO. |
| 2 | Health endpoint reports Drive reachability without exposing the drive ID to non-admins. Provider unit tests pass against the stub with zero network access. Boot with `GOOGLE_DRIVE_STORAGE_ENABLED=false` performs no Google call. |
| 3 | `scripts/db/…` run twice is a no-op the second time. `review-indexes.ts` reports no unexpected index. Every existing test passes with no fixture change. A `FileVersion` document written before Phase 3 loads, downloads and previews correctly. |
| 4 | `getStorageLocation` returns a locator; all six read paths compile with no cast. Download of a local file is byte-identical before and after. Range requests work against both providers. |
| 5 | Item count of the target Shared Drive projected and recorded (R1). No folder deeper than 19 in the migrated set (R2). L1 rollback executed and every file re-downloaded successfully. Killing the worker mid-transfer and restarting produces no duplicate Drive file. |
| 6 | Upload tray unchanged in code. A 1 GB upload completes with server RSS growth under 100 MB. Finalize interruption is recoverable. |
| 7 | Every mutation is Drive-then-Mongo; an injected Drive failure leaves both sides at the original state and the user sees a plain error. |
| 8 | An approved file whose Drive revision changes returns to review within one sync cycle, and its prior approval record is intact. |
| 9 | Token expiry (`404 startPageToken`) triggers a full reconcile rather than data loss. Replaying the same change page twice creates no duplicate records. |
| 10 | Each batch produces a stored report. Employees complete a working day on migrated data with no incident. |
| 11 | Local deletion requires an explicit admin action with a typed confirmation, is audited, and is refused for any version whose `migrationStatus ≠ 'verified'` or whose retention window has not elapsed. |

---

## 13. Open questions for the customer — needed before Phase 5, not before Phase 1

1. **Corpus size.** Current `FileVersion` + `Folder` document counts, for R1. Phases 1–4 proceed regardless.
2. **Folder depth.** Does any live tree exceed 19 levels? (R2)
3. **Employee Drive access.** Should employees see the Shared Drive in their own Drive UI at all? The brief's §13 implies no. That is the safer default and is assumed until stated otherwise.
4. **Google-native creation.** Does the product need "New → Google Doc" *inside* the application, or only the ability to hold and track natively-created documents? Affects Phase 8 scope materially.
5. **One Shared Drive or one per department?** Only matters if R1 is triggered.

---

## Phase 0 verdict

The migration is **feasible without rebuilding the application**, and the codebase is unusually well positioned for it: storage is already behind an interface, only 8 modules touch it, physical location is already confined to one document type, and one function (`getStorageLocation`) is the single read chokepoint.

The three things that will actually bite, in order: the Shared Drive **item limit** (R1), the **folder depth limit** (R2), and the **version-immutability hook** (R3). The first two are external hard ceilings that must be measured before Phase 5 is planned; the third is a five-line change that is invisible until it fails.

Proceeding to Phase 1: storage-provider abstraction, local only, no Google code in any production path.
