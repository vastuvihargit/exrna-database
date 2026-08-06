# Cloudflare Migration — Phase 0 Analysis

**Status:** analysis only. No code has been changed.
**Scope of this document:** what exists today, what has to change, what is blocked, and in what order.

---

## 0. Executive summary — read this first

Three findings change the shape of the migration. They are stated up front because two of them
invalidate the phase plan as originally sequenced.

### Finding 1 — Google Drive is not currently the file-storage provider

The brief says "Google Shared Drive must remain the actual file-storage provider" and "do not
replace Google Drive file storage". That is not the state of the code.

The application stores file bytes on a **local server filesystem**
(`LOCAL_STORAGE_ROOT`, `.data/storage`, mounted volume in Docker). Google Shared Drive is a
**fully implemented but flag-gated secondary provider**:

| Setting | Default | Value in the checked-in `.env` |
|---|---|---|
| `GOOGLE_DRIVE_STORAGE_ENABLED` | `false` | not set → `false` |
| `DEFAULT_STORAGE_PROVIDER` | `local` | not set → `local` |
| `GOOGLE_SHARED_DRIVE_ID` | — | not set |

`src/server/storage/index.ts:registerProviders()` only registers the Drive store when the flag is
on. Every `FileVersion` row carries `storageProvider: 'local'` and a `storageKey` pointing at a
path on disk.

**Cloudflare Workers have no filesystem.** So this is not a "keep Drive as it is" migration — it is:

> every version whose bytes are still on local disk must be transferred into the Shared Drive
> **before** the Worker becomes the serving runtime, or that file becomes unreadable.

The good news: the tooling for exactly this already exists and is tested
(`storage-migration.service.ts`, `storage-migration/{planner,runner,transfer,drive-mirror,folder-mirror,local-copies}.ts`,
`tests/integration/storage-migration.test.ts`, `docs/storage-migration/*`). It has dry-run mode,
per-item idempotency keys, checksum verification, and rollback. It has simply not been run.

**Consequence:** a new **Phase 1a — complete the Drive storage cutover** must run before, or in
parallel with, the Worker work. This is called out again in §9.

### Finding 2 — Phase 1's acceptance criteria are not simultaneously satisfiable

Phase 1 says "configure for Workers … do not change the database yet" and requires
"Worker preview runs locally" plus "existing pages render correctly".

Mongoose speaks the MongoDB wire protocol over a raw TCP socket. Workers have no raw TCP to
MongoDB, and Hyperdrive supports Postgres and MySQL only — not MongoDB. Therefore a Worker
build **can compile** but **cannot serve a data-backed page**.

> **Corrected in Phase 1.** This was too strong. Under `wrangler dev --local` with
> `nodejs_compat`, the Worker connected to MongoDB successfully (394 ms, `status: ok`) —
> workerd now backs `node:net` with real outbound TCP and the driver works over it. What
> remains unproven is the *deployed* case: an endpoint reachable from Cloudflare's network,
> TLS through workerd's sockets, and `mongodb+srv://` SRV resolution. The conclusion that
> Mongoose must not be the deployed data path stands, and Phase 3 replaces it either way.
> See `01-phase-1-worker.md` §6.

Phase 1 acceptance is therefore split honestly into:

* **1-A (achievable now):** the project *builds* for Workers, `wrangler.jsonc` / `open-next.config.ts`
  / bindings / environments exist, the Node-only surface is inventoried and isolated behind
  interfaces, and a Worker preview boots and serves the routes that do not touch MongoDB
  (`/api/version`, `/api/health`, static shell, login page).
* **1-B (achievable only after Phase 3):** full page rendering under the Worker.

Node deployment stays the production runtime throughout Phases 1–6. The Worker is a parallel
target, not a replacement, until Phase 7.

### Finding 3 — the codebase is unusually well-prepared for this

`tests/unit/architecture-boundaries.test.ts` already enforces:

1. `src/server/**` contains **no Next.js or React imports** outside `src/server/http/`.
2. filesystem access is **confined to `src/server/storage/**`**.
3. UI components and hooks never import `@/server/{db,repositories,storage,services}` or `mongoose`.

The layering the brief asks for — *route → service → permission check → repository → DB* — is
already real and machine-verified. Mongoose is confined to 71 files, of which 26 are repositories
and 32 are model definitions. **No service, route or component issues a Mongoose query directly**
except through the repository modules. This is what makes Phase 3 a bounded, module-by-module
substitution instead of a rewrite.

---

## 1. Current architecture

### 1.1 Runtime and deployment

```
Browser
  └─ Next.js 15 App Router (React 19, Node.js 22, output: 'standalone')
       ├─ src/middleware.ts        — cookie presence check + redirect only
       ├─ src/app/(auth)|(drive)   — 36 pages, server components + client islands
       └─ src/app/api/**           — 118 route handlers
            └─ withAuthenticatedRoute()   (session, CSRF, same-origin, rate limit)
                 └─ service          (business rules, orchestration)
                      └─ authorize()  (permission decision)
                           └─ repository  (26 modules, the only Mongoose callers)
                                └─ MongoDB (replica set rs0 — transactions required)
                           └─ storage registry
                                ├─ LocalObjectStore  → local disk   ← DEFAULT TODAY
                                └─ GoogleDriveObjectStore → Shared Drive (flag-gated, off)
```

Deployed with Docker Compose: `app`, `mongodb` (single-node replica set, auth + keyfile),
`nginx` (TLS termination), `clamav` (optional AV), `backup`, and a **`scheduler`** container that
runs the cron jobs.

### 1.2 Background jobs (today: cron in the `scheduler` container)

| Script | Purpose | Cadence |
|---|---|---|
| `scripts/sync-drive-changes.ts` | Drive change-feed poll → apply renames/moves/trashes | `DRIVE_SYNC_INTERVAL_MINUTES` (15) |
| `scripts/drain-drive-transfers.ts` | Push queued local versions into Drive | every few minutes |
| `scripts/purge-trash.ts` | Permanent delete past `TRASH_RETENTION_DAYS` | daily |
| `scripts/cleanup-uploads.ts` | Remove abandoned upload sessions + quarantined bytes | hourly |
| `scripts/check-approved-content.ts` | Approval-integrity sweep vs Drive revisions | daily |
| `scripts/monitor.ts` | Health checks → `alertStates` + webhook | 15 min |
| `scripts/verify-storage-integrity.ts` | Checksum audit | on demand |
| `scripts/seed.ts`, `init-storage.ts`, `review-indexes.ts` | setup | on demand |

Long-running work (storage migration, Drive import) is driven **from HTTP routes** by an
in-process runner (`storage-migration/runner.ts`, `migration.service.ts`) with claim-based
locking in MongoDB — not a queue.

### 1.3 Authentication (today)

* **Password login** — Argon2id via `@node-rs/argon2`, company-domain check, lockout, rate limit.
* **Google OAuth login** — hand-rolled OIDC: PKCE, `state`/`nonce`, JWKS fetch, RS256 verify via
  `node:crypto` `createPublicKey`/`createVerify`.
* **Server-side sessions** — opaque 32-byte token in `bd_session` (httpOnly), SHA-256 stored;
  separate CSRF token in `bd_csrf` (readable) + `x-csrf-token` header on unsafe methods.
* **Immediate deactivation** — `resolveSession()` re-reads `user.status` and
  `user.passwordUpdatedAt` on **every request** and revokes on mismatch.
* **Authorization** — `canAccess()` in `src/server/permissions/authorize.ts`. Ordered resolution:
  inactive → cross-org → deleted → **explicit deny wins** → super admin → direct ACL →
  inherited ACL (walk `pathAncestors` leaf→root, stop at `inheritPermissions: false`) → owner →
  role scope + confidentiality gate. `assertCan()` returns **404 not 403** when the actor cannot
  even view the resource — this is the anti-enumeration property and must survive the migration.

### 1.4 Google Drive integration

* `src/server/storage/google/drive-client.ts` (791 lines) — the **only** module that speaks HTTP
  to Drive. Uses `fetch` against `https://www.googleapis.com/drive/v3` and
  `/upload/drive/v3`. Resumable uploads, change feed, revisions, export of Google-native docs.
* `drive-auth.ts` — service-account JWT via `google-auth-library` (`JWT` class).
* `drive-config.ts` — reads the PEM key from a **mounted file** (`fs.readFileSync`) or inline env.
* `google-drive-object-store.ts` — implements `ObjectStore` + `HierarchicalStorageProvider`.
* Drive ids are stored on `fileVersions.googleDriveFileId` (unique partial index) and
  `folders.googleDriveFolderId` (unique partial index). **These indexes are the duplicate-upload
  guarantee and must be reproduced in D1 as partial unique indexes.**

---

## 2. MongoDB collections (32 registered models)

Source: `src/server/db/models/index.ts:registeredModels`.

| # | Collection | Model file | Notes |
|---|---|---|---|
| 1 | `organizations` | `organization.model.ts` | tenant root, embedded `settings` |
| 2 | `appsettings` | `app-setting.model.ts` | key/value, `Mixed` value |
| 3 | `users` | `user.model.ts` | embedded `authProviders[]`, `mfa`, `preferences`, `projectIds[]` |
| 4 | `departments` | `department.model.ts` | |
| 5 | `roles` | `role.model.ts` | `permissions[]`, `scopeTypes[]` arrays |
| 6 | `userroles` | `user-role.model.ts` | scoped grants; partial unique on active |
| 7 | `sessions` | `session.model.ts` | TTL index on `absoluteExpiresAt` |
| 8 | `loginhistories` | `login-history.model.ts` | TTL 400 days |
| 9 | `auditlogs` | `audit-log.model.ts` | append-only, `Mixed` prev/new |
| 10 | `passwordresettokens` | `password-reset-token.model.ts` | TTL 1h |
| 11 | `projects` | `project.model.ts` | `memberUserIds[]`, `tags[]` |
| 12 | `folders` | `folder.model.ts` | `pathAncestors[]`, embedded `permissions[]` ACL |
| 13 | `stars` | `star.model.ts` | |
| 14 | `activities` | `activity.model.ts` | `contextFolderIds[]`, `Mixed` detail |
| 15 | `recentitems` | `recent-item.model.ts` | |
| 16 | `files` | `file.model.ts` | `folderPathAncestors[]`, ACL, `Mixed` metadata, `tags[]` |
| 17 | `fileversions` | `file-version.model.ts` | immutability hook, Drive fields |
| 18 | `uploadsessions` | `upload-session.model.ts` | `receivedChunks[]` |
| 19 | `savedsearches` | `saved-search.model.ts` | `Mixed` criteria |
| 20 | `comments` | `comment.model.ts` | `mentionedUserIds[]` |
| 21 | `notifications` | `notification.model.ts` | one row per recipient |
| 22 | `reviews` | `review.model.ts` | **embedded `decisions[]`** |
| 23 | `experiments` | `experiment.model.ts` | `collaboratorUserIds[]`, `sampleIds[]`, `tags[]` |
| 24 | `migrationjobs` | `migration-job.model.ts` | inbound Drive importer; sealed refresh token |
| 25 | `migrationitems` | `migration-item.model.ts` | |
| 26 | `alertstates` | `alert-state.model.ts` | monitor cooldown |
| 27 | `inventoryitems` | `inventory-item.model.ts` | **embedded `batches[]`**, `documentFileIds[]` |
| 28 | `stocktransactions` | `stock-transaction.model.ts` | append-only ledger |
| 29 | `storagemigrationjobs` | `storage-migration-job.model.ts` | `Mixed` counters, selection |
| 30 | `storagemigrationitems` | `storage-migration-item.model.ts` | claim locking |
| 31 | `storagerecoveryitems` | `storage-recovery-item.model.ts` | crash recovery |
| 32 | `drivesyncstates` | `drive-sync-state.model.ts` | Drive change cursor |

---

## 3. D1 table mapping

**Principle:** every `_id` becomes `TEXT PRIMARY KEY` holding the 24-character hex ObjectId string,
unchanged. Every `Date` becomes `TEXT` ISO-8601 UTC. Every `Boolean` becomes `INTEGER` 0/1.
Every embedded array that is queried or joined becomes a child table; every embedded object that is
only ever read whole becomes a `TEXT` JSON column.

### 3.1 Direct 1:1 mappings

| MongoDB collection | D1 table |
|---|---|
| `organizations` | `organizations` (+ `settings` JSON TEXT) |
| `appsettings` | `app_settings` (`value` JSON TEXT) |
| `users` | `users` (+ `preferences`, `mfa` JSON TEXT) |
| `departments` | `departments` |
| `roles` | `roles` |
| `userroles` | `user_roles` |
| `sessions` | `sessions` |
| `loginhistories` | `login_history` |
| `auditlogs` | `audit_logs` (`previous_value`, `new_value` JSON TEXT) |
| `passwordresettokens` | `password_reset_tokens` |
| `projects` | `projects` |
| `folders` | `folders` |
| `stars` | `stars` |
| `activities` | `activities` (`detail` JSON TEXT) |
| `recentitems` | `recent_items` |
| `files` | `files` |
| `fileversions` | `file_versions` |
| `uploadsessions` | `upload_sessions` (`received_chunks` JSON TEXT) |
| `savedsearches` | `saved_searches` (`criteria` JSON TEXT) |
| `comments` | `comments` |
| `notifications` | `notifications` |
| `reviews` | `reviews` |
| `experiments` | `experiments` |
| `migrationjobs` | `import_jobs` (renamed — see note) |
| `migrationitems` | `import_items` |
| `alertstates` | `alert_states` |
| `inventoryitems` | `inventory_items` |
| `stocktransactions` | `stock_transactions` |
| `storagemigrationjobs` | `storage_migration_jobs` (`selection`, `counters`, `throughput_samples`, `failure_counts` JSON TEXT) |
| `storagemigrationitems` | `storage_migration_items` |
| `storagerecoveryitems` | `storage_recovery_items` |
| `drivesyncstates` | `drive_sync_states` |

> **Naming note.** `migrationjobs`/`migrationitems` are the *inbound* Drive importer.
> `storagemigration*` is the *outbound* Shared Drive backend. This migration adds a **third**
> meaning of the word. To keep the audit log and the admin UI readable, the inbound importer is
> renamed to `import_jobs`/`import_items` in D1, and the MongoDB→D1 migration itself uses the
> prefix `d1_migration_*`. The `AUDIT_ACTIONS` enum keeps its existing `migration.*` strings
> unchanged — those are persisted data.

### 3.2 Embedded arrays → child tables (mandatory)

| Source | D1 table | Why it cannot be JSON |
|---|---|---|
| `folders.permissions[]`, `files.permissions[]` | `resource_permissions(resource_type, resource_id, principal_type, principal_id, access_level, deny, expires_at, granted_by, granted_at)` | `resourceVisibilityFilter()` matches `permissions.principalId` in the listing query — must be indexed |
| `folders.pathAncestors[]` | `folder_ancestors(folder_id, ancestor_id, depth)` | subtree queries `{ pathAncestors: id }`, breadcrumbs, circular-move checks |
| `files.folderPathAncestors[]` | `file_folder_ancestors(file_id, ancestor_id, depth)` | "everything under this folder" is a single indexed query today |
| `reviews.decisions[]` | **`approvals`** | the brief's `approvals` table; needed for "who signed what, when, from where" |
| `inventoryitems.batches[]` | `inventory_batches` | expiry-aware issuing (FEFO) needs per-batch rows |
| `projects.memberUserIds[]` + `users.projectIds[]` | **`project_members`** (single source of truth) | the two are denormalized copies today; D1 keeps one |
| `experiments.collaboratorUserIds[]` | `experiment_collaborators` | |
| `experiments.sampleIds[]` | `experiment_samples` | searched (`organizationId + sampleIds` index) |
| `comments.mentionedUserIds[]` | `comment_mentions` | indexed for "mentions of me" |
| `activities.contextFolderIds[]` | `activity_folders` | folder-timeline query |
| `users.authProviders[]` | `user_auth_providers` | looked up by `providerAccountId` |
| `roles.permissions[]` | **`role_permissions`** + `permissions` catalogue | the brief's tables |
| `roles.scopeTypes[]` | `role_scope_types` | |
| `files.metadata` (Mixed) | **`file_metadata(file_id, key, value)`** | the brief's table; searched by `sampleId`, `experimentCode` |
| `files.tags[]`, `projects.tags[]`, `experiments.tags[]` | `resource_tags(resource_type, resource_id, tag)` | faceted search |
| `inventoryitems.documentFileIds[]` | `inventory_item_documents` | |
| `stocktransactions.documentFileIds[]` | `stock_transaction_documents` | |
| `storagemigrationjobs.selection.*Ids[]` | `storage_migration_job_selection` | |

### 3.3 New tables required by the target architecture

| Table | Purpose |
|---|---|
| `sync_jobs` | the brief's requirement: queue/workflow job status visible to admins |
| `queue_messages` | dead-letter and retry ledger; `idempotency_key` unique |
| `d1_migration_runs` | MongoDB→D1 migration checkpoints, counts, resume cursor |
| `d1_migration_failures` | per-record failure report |
| `files_fts`, `folders_fts`, `experiments_fts` | FTS5 virtual tables replacing MongoDB `$text` |

### 3.4 Worked example — `files`

```sql
CREATE TABLE files (
  id                      TEXT PRIMARY KEY,              -- preserved ObjectId hex
  organization_id         TEXT NOT NULL REFERENCES organizations(id),
  display_name            TEXT NOT NULL,
  display_name_lower      TEXT NOT NULL,
  original_filename       TEXT NOT NULL,
  extension               TEXT NOT NULL,
  category                TEXT NOT NULL DEFAULT 'other',
  folder_id               TEXT NOT NULL REFERENCES folders(id),
  drive_type              TEXT NOT NULL,                 -- my | department | project
  owner_id                TEXT NOT NULL REFERENCES users(id),
  department_id           TEXT REFERENCES departments(id),
  project_id              TEXT REFERENCES projects(id),
  experiment_id           TEXT REFERENCES experiments(id),
  current_version_id      TEXT,                          -- FK added after file_versions exists
  approved_version_id     TEXT,
  version_count           INTEGER NOT NULL DEFAULT 0,
  size_bytes              INTEGER NOT NULL DEFAULT 0,
  mime_type               TEXT NOT NULL DEFAULT 'application/octet-stream',
  checksum_sha256         TEXT,
  confidentiality         TEXT NOT NULL DEFAULT 'internal',
  review_status           TEXT NOT NULL DEFAULT 'draft',
  approval_status         TEXT NOT NULL DEFAULT 'none',
  status                  TEXT NOT NULL DEFAULT 'active',
  inherit_permissions     INTEGER NOT NULL DEFAULT 1,
  storage_provider        TEXT NOT NULL DEFAULT 'local',
  has_google_native_content INTEGER NOT NULL DEFAULT 0,
  download_count          INTEGER NOT NULL DEFAULT 0,
  last_accessed_at        TEXT,
  created_by              TEXT NOT NULL REFERENCES users(id),
  updated_by              TEXT REFERENCES users(id),
  archived_at             TEXT,
  trashed_with_folder_id  TEXT REFERENCES folders(id),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,
  deleted_by              TEXT REFERENCES users(id)
);

CREATE INDEX idx_files_folder      ON files(folder_id, deleted_at, display_name);
CREATE INDEX idx_files_owner       ON files(organization_id, owner_id, deleted_at);
CREATE INDEX idx_files_department  ON files(organization_id, department_id, deleted_at);
CREATE INDEX idx_files_project     ON files(organization_id, project_id, deleted_at);
CREATE INDEX idx_files_review      ON files(organization_id, review_status, updated_at DESC);
CREATE INDEX idx_files_approval    ON files(organization_id, approval_status, updated_at DESC);
CREATE INDEX idx_files_checksum    ON files(checksum_sha256);
```

Note the brief's example schema puts `google_drive_file_id` on `files`. **It must not go there.**
`file.model.ts` states the rule explicitly: a `File` never holds a storage address, so a physical
location cannot leak through a file listing. Drive ids live on `file_versions`:

```sql
CREATE UNIQUE INDEX idx_file_versions_drive_id
  ON file_versions(google_drive_file_id)
  WHERE google_drive_file_id IS NOT NULL;   -- reproduces the Mongo partial unique index
```

This partial unique index is the hard, database-level guarantee against a retried transfer
recording a second Drive file for one version. Same for `folders.google_drive_folder_id`.

### 3.5 What must **not** go into D1

* File binaries and previews — remain in the Shared Drive.
* Extracted document text — `officeparser` output is not persisted today and must not start.
* `.data/quarantine` bytes — upload staging (see §4.7).

---

## 4. Cloudflare Worker compatibility problems

Ordered by severity. "Blocker" means the feature cannot work in a Worker without a design change.

### 4.1 Blocker — `@node-rs/argon2`

`src/server/auth/password.ts`. A native Rust N-API addon. There is no Workers build. Password
hashing and verification cannot run in a Worker.

**Resolution:** Phase 8 replaces password login with Cloudflare Access, which removes the need for
Argon2 entirely. Until then, `password.ts` moves behind a `PasswordHasher` interface with two
implementations — the existing Argon2 one for the Node deployment, and a `null` implementation for
the Worker that refuses password login with a clear error. **Do not** substitute PBKDF2 via
WebCrypto for existing hashes: they are Argon2id and cannot be re-verified with anything else.
Existing `passwordHash` values migrate to D1 untouched and become dormant.

### 4.2 Blocker — `mongoose`

71 files import it. Wire-protocol TCP is unavailable in Workers; Hyperdrive does not support
MongoDB. Resolved by Phase 3 (repository substitution), not by Phase 1.

### 4.3 Blocker — local filesystem storage

`src/server/storage/local-provider.ts`, `local-object-store.ts` use `fs`, `fs/promises`,
`stream/promises`. `drive-config.ts` uses `fs.readFileSync` for the service-account PEM.
`backup-status.ts` uses `fs/promises`.

**Resolution:**
* Service-account key → Worker **secret** (`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`), no file read.
* Local object store → not registered in the Worker build. Requires Finding 1 to be resolved:
  all versions must be `storageProvider: 'google_drive'` and `migrationStatus: 'verified'`.
* `backup-status.ts` → replaced by a D1-backed status row.

### 4.4 Blocker — `node:net` (ClamAV)

`src/server/security/malware-scanner.ts` opens a raw TCP socket to ClamAV. Workers cannot.
Currently `MALWARE_SCAN_ENABLED=false` by default.

**Resolution:** the scanner moves behind the existing interface with a Worker implementation that
either (a) is disabled, matching today's default, or (b) calls an HTTP scanning service. Must be
surfaced on the admin System page as a stated risk, exactly as the current code does — never
silently dropped.

### 4.5 Blocker — Node streams throughout the I/O path

`ObjectStore.read()` returns `NodeJS.ReadableStream`; `SaveFileInput.body` is one.
Affected: `types.ts`, `drive-client.ts`, `google-drive-object-store.ts`, `file-response.ts`,
`request-stream.ts`, `upload.service.ts`, `download.service.ts`, `health-service.ts`,
`storage-migration/transfer.ts`, `migration/google-drive-client.ts`.

`node:stream` is available under `nodejs_compat`, and `Readable.toWeb`/`fromWeb` work, but the
correct move is to make the storage interfaces speak **Web Streams** natively:
`ReadableStream<Uint8Array>` in, `Response.body` out. `drive-client.ts` already uses `fetch`, so
its natural output is already a Web stream — the Node conversion is currently added on top.

### 4.6 Blocker — in-memory rate limiter

`src/server/auth/rate-limit.ts` holds a `Map` in module scope. In Workers each isolate has its own,
so limits become per-isolate and effectively unenforced.

**Resolution:** a `RateLimiter` interface with the current in-memory implementation for Node and a
Durable Object (or Workers Rate Limiting binding) implementation for the Worker. Applies to
`login`, `loginPerEmail`, `passwordReset*`, `authenticated`, `uploadAuthorize`, `search`.

### 4.7 Blocker — chunked upload staging

`POST /api/uploads/:id/chunks/:i` writes each chunk to `.data/temporary`, then finalize assembles,
checksums, virus-scans and stores. There is no disk in a Worker, and a single Worker request has
a memory ceiling.

**Resolution options** (decision needed, see §11):
1. **Direct resumable upload to Drive.** The Worker mints a Drive resumable session URI and the
   browser `PUT`s chunks straight to Google. The Worker records metadata on completion.
   Removes the byte path from the Worker entirely. Loses server-side AV and server-computed
   SHA-256 — Drive returns MD5, which the codebase already handles (`googleDriveMd5`).
2. **R2 as the staging area**, then Worker→Drive transfer via a Queue. Keeps checksum and AV
   behaviour but adds a storage product the brief did not ask for.

Recommendation: **option 1**, with `checksumSha256` computed in the browser and cross-checked
against Drive's MD5 server-side. It matches the brief's "do not move file binaries into D1" and
"Google Drive remains the storage provider" most directly.

### 4.8 Major — `node:crypto` usage

| File | Uses | Workers status |
|---|---|---|
| `auth/tokens.ts` | `randomBytes`, `createHash('sha256')`, `timingSafeEqual` | → `crypto.getRandomValues`, `crypto.subtle.digest`, constant-time compare in JS |
| `auth/secret-box.ts` | `createCipheriv`/`createDecipheriv` AES-256-GCM, `hkdfSync` | → `crypto.subtle` AES-GCM + HKDF. **Ciphertext format `v1.iv.tag.ct` must be preserved** — it seals the Drive-importer refresh token in existing rows |
| `auth/google-oauth.ts` | `createPublicKey({format:'jwk'})`, `createVerify('RSA-SHA256')` | → `crypto.subtle.importKey('jwk', …)` + `crypto.subtle.verify('RSASSA-PKCS1-v1_5', …)`. Clean 1:1 |
| `http/route-handler.ts` | `randomUUID` | → `crypto.randomUUID()` (global) |
| `storage/keys.ts` | `randomUUID` | same |
| `upload.service.ts`, `integrity.service.ts`, `storage-migration/transfer.ts`, `google-drive-object-store.ts` | streaming SHA-256/MD5 via `createHash` | needs an incremental hasher; `crypto.subtle.digest` is one-shot. Resolved by §4.7 option 1 (browser-side hashing) |
| `local-provider.ts` | `createHash` | not registered in Worker |

### 4.9 Major — `pino`

`src/server/logging/logger.ts`. Pino targets Node; `pino-pretty` uses worker threads and
`serverExternalPackages` currently externalizes both.

**Resolution:** a `Logger` interface. Worker implementation writes structured JSON to `console`,
which Workers Logs / Tail ingests. **The `REDACTED_PATHS` list must be reimplemented, not
dropped** — it redacts `storageKey`, `absolutePath`, `tokenHash`, `cookie`, `authorization`.

### 4.10 Major — MongoDB transactions

25 `withTransaction()` call sites across `file`, `folder`, `project`, `review`, `upload`,
`version`, `migration`, `approval-integrity` services. D1 has **no interactive transactions** —
only `db.batch()` (one atomic statement list, no reads between writes).

Each site needs review. Three patterns:

| Pattern | D1 approach |
|---|---|
| Several writes, no intervening reads (e.g. create file + version + counter bump) | `db.batch()` — directly equivalent |
| Read-modify-write on one row (counters, quota) | conditional `UPDATE … WHERE current_value = ?` + affected-row check, retry |
| Read-decide-write across rows (folder move, version restore, approval close) | optimistic concurrency: version/etag column, `UPDATE … WHERE updated_at = ?`, fail and retry |

The inventory issue path is already written as a single atomic `findOneAndUpdate` with a
`quantity >= n` filter — that translates directly to
`UPDATE inventory_batches SET quantity = quantity - ? WHERE id = ? AND quantity >= ?` and
`changes() = 1`. **Negative stock prevention is preserved by the WHERE clause, not by a transaction.**

### 4.11 Major — full-text search

`files.$text` (weighted `file_search` index) and `experiments.$text` (`experiment_search`),
with `$meta: 'textScore'` relevance sorting. Folders and inventory already use `regex`/substring.

**Resolution:** SQLite **FTS5** virtual tables with `bm25()` weighting mirroring the current
weights (`displayName` 10, `originalFilename` 6, `tags` 5, `metadata.sampleId` 5,
`metadata.experimentCode` 5, `metadata.description` 1). Kept in step by triggers or by the
`SYNC_QUEUE` search-indexing consumer.

**Security note:** search must stay permission-filtered *before* and *after* the index query —
`search.service.ts` currently does both (`resourceVisibilityFilter` in the query, then a second
`can(actor,'file.view',…)` pass on the results). Both passes must survive.

### 4.12 Moderate — 7 aggregation pipelines

`file.repository.ts` (6), plus one each in `experiment`, `inventory-item`, `migration`,
`storage-migration`, `storage-usage`, `upload-session`. All are `$match`/`$group`/`$sum` counters
and facets — plain `GROUP BY` in SQL. No `$lookup`, `$graphLookup` or `$unwind` chains. Low risk.

### 4.13 Moderate — env access at module scope

`src/server/config/env.ts` reads `process.env` and calls `process.cwd()` and `path.resolve` at
import time. Workers expose bindings only via the request/execution context; `process.env` is
polyfilled under `nodejs_compat` but the *storage-root* logic is meaningless in a Worker.

**Resolution:** `getCloudflareContext()` from `@opennextjs/cloudflare` inside a lazy accessor;
a separate `env.worker.ts` schema that drops all six storage-root variables and adds the bindings.

### 4.14 Moderate — `officeparser`

Declared in `package.json` but **not imported anywhere in `src/`**. Dead dependency. Remove in
Phase 9 (it pulls native/Node-only code that would break the Worker bundle if it were used).

### 4.15 Moderate — Next.js build configuration

`next.config.ts` uses `output: 'standalone'` (incompatible with OpenNext — must be removed),
`serverExternalPackages: ['mongoose','pino','pino-pretty']`, a custom `webpack()` hook with
`NormalModuleReplacementPlugin` (OpenNext builds with Turbopack/webpack differently — needs
verification), and `pageExtensions` toggling `.dev.ts` routes. The `headers()` rules — including
the preview-route CSP exception — must be preserved exactly.

### 4.16 Moderate — tests

46 test files. `mongodb-memory-server` spawns a real `mongod`; `vitest.config.ts` sets
`fileParallelism: false` for that reason. The security suites (12 files) assert real permission
behaviour against a real database. These must be **ported to run against a local D1
(`better-sqlite3` / `wrangler d1 execute --local`), not deleted**, and the Mongo versions kept
running in parallel until Phase 7.

### 4.17 Minor

* `src/middleware.ts` — cookie-presence only, no Node APIs. Works as-is; Phase 8 replaces its
  role with Cloudflare Access.
* `AsyncLocalStorage` — not used. Good.
* No `setInterval` in server code. Good.
* `officeparser`, `mongodb-memory-server` — build-time only concerns.

---

## 5. Files that require changes

Counts are exact. "Unchanged" is as important as "changed".

### 5.1 New files (Phase 1)

```
wrangler.jsonc
open-next.config.ts
.dev.vars.example
src/server/config/env.worker.ts
src/server/runtime/index.ts            — runtime capability registry (see below)
src/server/runtime/node.ts
src/server/runtime/worker.ts
src/server/logging/logger.worker.ts
src/server/auth/rate-limit.durable.ts
docs/cloudflare-migration/01-phase-1-worker.md
```

### 5.2 Modified in Phase 1 (13 files)

| File | Change |
|---|---|
| `package.json` | add `@opennextjs/cloudflare`, `wrangler`, `drizzle-orm`, `drizzle-kit`; add `preview`/`deploy`/`cf-typegen` scripts |
| `next.config.ts` | drop `output: 'standalone'`; keep headers, `pageExtensions`; review the webpack hook |
| `src/server/config/env.ts` | lazy accessor; split Node-only storage roots out |
| `src/server/logging/logger.ts` | behind the `Logger` interface |
| `src/server/auth/rate-limit.ts` | behind the `RateLimiter` interface |
| `src/server/auth/password.ts` | behind the `PasswordHasher` interface |
| `src/server/auth/tokens.ts` | WebCrypto implementation |
| `src/server/auth/secret-box.ts` | WebCrypto AES-GCM, **same ciphertext format** |
| `src/server/auth/google-oauth.ts` | `crypto.subtle` JWKS verification |
| `src/server/http/route-handler.ts` | global `crypto.randomUUID` |
| `src/server/security/malware-scanner.ts` | behind the `MalwareScanner` interface |
| `src/server/storage/index.ts` | conditional provider registration by runtime |
| `tsconfig.json` | add `worker-configuration.d.ts` |

### 5.3 Modified in Phase 2 (schema)

```
src/server/db/schema/*.ts        (new — ~50 Drizzle table definitions)
drizzle/migrations/*.sql         (new)
drizzle.config.ts                (new)
```

### 5.4 Modified in Phase 3 (repositories — the bulk)

All **26** repository modules, one per sub-phase group:

```
user, department            → 3.1
role                        → 3.2
project, experiment         → 3.3
folder, file                → 3.4
file-version                → 3.5
saved-search, star, recent-item, activity  → 3.6
review, comment             → 3.7
audit-log, login-history    → 3.8
inventory-item              → 3.9
notification                → 3.10
session, upload-session, organization, app-setting, storage-usage,
migration, storage-migration, drive-sync                  → 3.11 (infrastructure)
```

Plus `src/server/permissions/visibility.ts` (rewrites Mongo filter objects as SQL predicates) and
`src/server/db/connection.ts` → `withBatch()` replacing `withTransaction()`.

### 5.5 Files that should **not** change

* **All 86 components and 36 pages.** The UI is not touched.
* **All 14 hooks.** They call `/api/*` and depend only on response shape.
* **All 118 API route handlers** — they call services, never repositories. (A handful will change
  in Phase 8 for Cloudflare Access identity.)
* **All 37 service modules** — except where `withTransaction` is called (8 files) and where the
  storage interface changes shape.
* `src/server/domain/*` — pure logic, no I/O. Zero changes.
* `src/server/validation/*` — Zod schemas. Zero changes.
* `src/server/http/dto.ts` — the API response contract. **Zero changes is the acceptance test.**

---

## 6. Authentication migration plan

### 6.1 Target

```
Cloudflare Access  →  who may enter the application  (Google Workspace SSO, company domain)
D1 roles/permissions →  what they may do once inside  (unchanged logic)
```

### 6.2 Steps

1. **Access application** in front of the Worker route, identity provider = the company Google
   Workspace, policy = `emails ending in @<GOOGLE_WORKSPACE_DOMAIN>` **and** group membership if
   Workspace groups are in use. No public registration path exists today and none is added.
2. **Backend validation of the Access JWT.** Access sends `Cf-Access-Jwt-Assertion`. The Worker
   verifies it against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (RS256, `aud` =
   the Access application AUD tag, `iss` = the team domain, `exp`). This reuses almost exactly the
   JWKS verification already written in `google-oauth.ts`. **Never trust `Cf-Access-Authenticated-User-Email`
   without verifying the JWT** — headers are forgeable if the Worker is ever reachable directly.
3. **Worker-level defence in depth.** Bind a service token / mTLS or an Access-only route so the
   Worker refuses requests lacking a valid Access assertion, so a direct `workers.dev` hit cannot
   bypass Access.
4. **Identity → Actor.** A new `resolveAccessIdentity()` replaces `resolveSession()`'s token
   lookup but keeps everything after it verbatim:
   * look up `users` by verified email;
   * **reject if `status !== 'active'`** — this preserves the immediate-deactivation guarantee;
   * load role grants, build the same `Actor` object.
   The `Actor` shape does not change, so `authorize.ts` and every service are untouched.
5. **Sessions.** Cloudflare Access holds the session. The `sessions` table is retained for the
   Node rollback path and for the audit trail, and `loginHistory` continues to be written from the
   Access identity (outcome `success`, provider `cloudflare_access`).
6. **CSRF.** With Access, the browser still sends cookies automatically, so CSRF protection stays.
   `assertSameOrigin()` + the `x-csrf-token` header remain. The CSRF token becomes a value derived
   from the Access session id rather than from a Mongo session row.
7. **Deactivation.** Two layers: D1 `status` check on every request (immediate, already exists),
   plus removal from the Access policy/group (stops them reaching the Worker at all). The D1 check
   is authoritative and must not be relaxed just because Access exists.
8. **Admin routes.** `assertCompanyPermission(actor, …)` is unchanged and still required —
   Access must never be the only thing standing between a normal employee and `/admin`.
9. **Password login and password reset** are removed once Access is live. `passwordHash`,
   `passwordResetTokens` and the `@node-rs/argon2` dependency are deleted in Phase 9 — **not before**,
   because they are the rollback path.
10. **Service-to-service** (queue consumers, workflows) authenticate with an Access **service token**,
    and act with a synthetic system actor that is audited as such.

### 6.3 What must be proven

* A valid company account with `status = 'deactivated'` is refused **by the application**, with
  Access still allowing entry (simulates the lag between HR and directory sync).
* A forged `Cf-Access-Authenticated-User-Email` header without a valid JWT is refused.
* An expired Access JWT is refused.
* A user with no role grants can reach the shell and see nothing they should not.

---

## 7. Data migration plan

### 7.1 Ordering (foreign keys dictate it)

```
1  organizations, app_settings
2  departments                    (self-FK parent_department_id — two passes)
3  users                          (FK department_id)
4  back-fill departments.head_user_id, users.invited_by/deactivated_by
5  roles → permissions → role_permissions → role_scope_types
6  user_roles
7  projects → project_members     (union of projects.memberUserIds and users.projectIds)
8  experiments → experiment_collaborators, experiment_samples
9  folders                        (topological by depth; then folder_ancestors)
10 back-fill departments.root_folder_id, projects.root_folder_id, experiments.folder_id
11 files → file_folder_ancestors, file_metadata, resource_tags
12 file_versions                  (then back-fill files.current_version_id/approved_version_id)
13 resource_permissions           (from folders.permissions[] and files.permissions[])
14 comments → comment_mentions
15 reviews → approvals            (from reviews.decisions[])
16 notifications
17 inventory_items → inventory_batches → inventory_item_documents
18 stock_transactions → stock_transaction_documents
19 stars, recent_items, saved_searches, activities → activity_folders
20 audit_logs                     (largest table; batched last)
21 login_history, sessions, upload_sessions
22 import_jobs/items, storage_migration_*, storage_recovery_items, drive_sync_states, alert_states
23 FTS5 index population
24 verification pass
```

Deferred FKs: SQLite in D1 supports `PRAGMA defer_foreign_keys` inside a transaction; the
migration uses it for the circular pairs (folders↔departments, files↔file_versions) rather than
creating rows with NULLs and forgetting to back-fill.

### 7.2 Transform rules

| Mongo | D1 | Rule |
|---|---|---|
| `ObjectId` | `TEXT` | `String(oid)` — 24 hex chars, **unchanged**, primary keys preserved |
| `Date` | `TEXT` | `date.toISOString()`, always UTC, always `Z` |
| `Boolean` | `INTEGER` | 1/0 |
| `null` ObjectId | `NULL` | not the string `"null"` |
| `Mixed` | `TEXT` | `JSON.stringify`, `NULL` when absent |
| `[ObjectId]` | child rows | ordinal preserved where order matters (`pathAncestors`) |
| missing field | column default | never invent a value |

### 7.3 Tooling requirements (all mandated by the brief)

* **Dry run** — reads MongoDB, transforms, validates, writes nothing, reports counts and would-be
  failures.
* **Batching** — D1 caps a batch; use ≤ 500 rows/statement group, ≤ 100 KB/statement.
* **Resume** — `d1_migration_runs(collection, last_id, rows_done, status)` checkpoint after every
  batch; restart continues from `last_id` (ObjectIds sort monotonically, so `_id > last_id` is a
  stable cursor).
* **Duplicate prevention** — `INSERT OR IGNORE` on the preserved primary key. Re-running is a no-op,
  which is what makes resume safe.
* **Failed-record report** — `d1_migration_failures(collection, source_id, reason, payload_json)`.
* **Count comparison** — per collection, Mongo `countDocuments` vs D1 `COUNT(*)`.
* **Relationship validation** — every FK column checked for orphans; `folder_ancestors` depth
  consistency; `files.current_version_id` resolves; `reviews.version_id` resolves.
* **Drive-id validation** — every non-null `google_drive_file_id` unique and matching the Mongo
  value; count of versions with `storage_provider='google_drive'` equal on both sides.
* **Permission validation** — total `resource_permissions` rows equals the sum of ACL array lengths.

Implemented as a **Cloudflare Workflow** (`MIGRATION_WORKFLOW`) so each collection is a step with
its own retry and the whole run survives restarts — this is what the brief's Phase 4 asks for.
MongoDB is read by an export step running **outside** the Worker (a Node script producing NDJSON to
R2 or a signed upload), because the Worker cannot connect to MongoDB. The Workflow consumes the
export.

### 7.4 Do not

* Delete or modify anything in MongoDB. The migration is read-only against the source.
* Switch production writes. Phases 5 and 6 are read-only verification.

---

## 8. Rollback plan

Rollback is available at every phase and is **cheap** because MongoDB is never written to by the
migration and never decommissioned early.

| Phase | If it fails | Rollback | Cost |
|---|---|---|---|
| 1 | Worker build broken | Node deployment untouched; `git revert` the config commit | minutes |
| 2 | Schema wrong | `wrangler d1 execute --file drop.sql`; no production impact | minutes |
| 3 | A repository misbehaves | Feature flag `DATA_SOURCE=mongo\|d1` per module; flip back | seconds |
| 4 | Queue/workflow jobs fail | Re-enable the cron `scheduler` container; jobs are idempotent | minutes |
| 5 | Migration corrupt | Truncate D1 and re-run; MongoDB is unchanged | hours |
| 6 | Verification mismatch | Nothing to roll back — reads only | none |
| 7 | Cutover fails | Flip DNS/Access back to the Node deployment; MongoDB has the final backup + the incremental window | < 15 min |
| 8 | Access misconfigured | Re-enable password login on the Node deployment (code still present until Phase 9) | minutes |

**Rollback expiry.** The MongoDB rollback path stays live for **30 days** after cutover
(matching `TRASH_RETENTION_DAYS` and the existing backup retention). Beyond that, writes made in
D1 exceed what an incremental re-migration back to Mongo could reconcile. Document the expiry date
at cutover and get it signed off. Backups are retained for the full
`BACKUP_RETENTION_DAYS` period regardless.

**Blocking condition on Phase 7:** the storage cutover (Finding 1) must be complete and
verified — every version `storage_provider='google_drive'`, `migration_status='verified'` —
because rolling back the *database* does not roll back the *bytes*, and a Worker cannot serve
local files at all.

---

## 9. Revised phase plan

Changes from the brief are marked **▲**.

| Phase | Content | Blocks | Est. |
|---|---|---|---|
| **0** | This analysis | — | done |
| **▲ 1a** | **Complete the Google Drive storage cutover.** Enable `GOOGLE_DRIVE_STORAGE_ENABLED`, run the existing storage-migration tooling dry-run → migrate → verify for every version. Set `DEFAULT_STORAGE_PROVIDER=google_drive`. Keep local copies (do **not** set `DELETE_LOCAL_AFTER_MIGRATION`). | 7 | large — depends on corpus size |
| **1** | Worker compatibility: OpenNext, wrangler, bindings, environments, runtime-capability interfaces, WebCrypto swaps, observability. **Acceptance split into 1-A / 1-B (§0 Finding 2).** | 3 | 2–3 days |
| **2** | D1 schema: ~50 Drizzle tables, FKs, indexes, partial unique indexes, FTS5 | 3 | 3–4 days |
| **3** | Repository migration, 11 sub-phases, flag-per-module | 5,6 | the bulk — 2–3 weeks |
| **4** | Queues (`SYNC_QUEUE`, `NOTIFICATION_QUEUE`) + Workflows (`MIGRATION_WORKFLOW`), DLQs, `sync_jobs` in D1, admin failure view | 7 | 4–5 days |
| **5** | Migration tool: export → validate → transform → batch insert → verify → report | 6 | 4–5 days |
| **6** | Dual verification, read-only, admin diff report | 7 | 2–3 days |
| **7** | Production cutover in a maintenance window | 8 | 1 day |
| **8** | Cloudflare Access + backend JWT validation | 9 | 2–3 days |
| **9** | Cleanup, only after verification and rollback expiry | — | 1 day |

Phases 1, 1a and 2 are independent and can run concurrently. Phase 3 needs 1 and 2.

---

## 10. Acceptance criteria

### Phase 0 (this document)

- [x] Complete project read: 32 models, 26 repositories, 37 services, 118 routes, 46 tests,
      86 components, 14 hooks, deployment and CI config inspected.
- [x] MongoDB collections enumerated with their embedded structures.
- [x] D1 table mapping produced, including every embedded array that must be normalized.
- [x] Worker incompatibilities enumerated with severity and resolution.
- [x] Authentication migration plan.
- [x] Data migration plan with ordering, transforms and validation.
- [x] Rollback plan with expiry.
- [x] Revised phase plan with the two blockers surfaced.
- [x] No code changed.

### Phase 1

- [ ] `npm run build` succeeds.
- [ ] `npx opennextjs-cloudflare build` succeeds.
- [ ] `npx wrangler dev` boots; `/api/version`, `/api/health` respond; the login shell renders.
- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` clean.
- [ ] `npm test` — all 46 files pass, unchanged, against the Node runtime.
- [ ] `tests/unit/architecture-boundaries.test.ts` still passes.
- [ ] No UI file modified (`git diff --stat src/components src/app/\(drive\) src/hooks` empty).
- [ ] `wrangler.jsonc` declares `DB`, `SYNC_QUEUE`, `NOTIFICATION_QUEUE`, `MIGRATION_WORKFLOW`
      for `development`, `staging`, `production`.
- [ ] No secret committed; `.dev.vars` is git-ignored.
- [ ] Node production deployment still builds and runs unchanged.

### Later phases

Per the brief, with these additions:

* **Phase 2** — the partial unique indexes on `file_versions.google_drive_file_id` and
  `folders.google_drive_folder_id` exist and are proven by an inserting test.
* **Phase 3** — `src/server/http/dto.ts` is byte-identical to its Phase 0 state; a response-shape
  snapshot test across all 118 routes passes.
* **Phase 6** — `assertCan()` returns **404, not 403**, for an actor who cannot view a resource,
  in D1 exactly as in Mongo.

---

## 11. Decisions needed before Phase 1 completes

1. **Upload path (§4.7)** — direct browser→Drive resumable upload (recommended) or R2 staging?
   This determines whether `upload.service.ts` changes shape in Phase 1 or Phase 4.
2. **Storage cutover timing (Phase 1a)** — when can the Drive migration be run against production,
   and what is the corpus size? This is the long pole.
3. **Malware scanning (§4.4)** — accept "disabled" in the Worker (matching today's default), or
   procure an HTTP scanning service?
4. **Rate limiting (§4.6)** — Durable Objects (precise, costs a DO) or the Workers Rate Limiting
   binding (cheaper, approximate)?
5. **Workspace groups** — are Google Workspace groups available for the Access policy, or is the
   policy email-domain only?

---

## 12. Files inspected

**Configuration** `package.json`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts`,
`eslint.config.mjs`, `.env`, `.env.example`, `Dockerfile`, `docker-compose{,.dev,.prod}.yml`,
`docker/*`, `.github/workflows/{ci,deploy}.yml`

**Data layer** all 32 `src/server/db/models/*.model.ts`, `base-schema.ts`, `acl-schema.ts`,
`connection.ts`, `storage-fields.ts`, `models/index.ts`

**Repositories** all 26 modules (read in full: `inventory-item`, `file`, `folder`; scanned: rest)

**Services** `search`, `inventory`, `file`, `folder`, `upload`, `drive`, `drive-sync`,
`storage-migration/*`, `auth`, `review`, `version`, `approval-integrity` and the remaining 25 by signature

**Auth & permissions** `session.service.ts`, `google-oauth.ts`, `password.ts`, `tokens.ts`,
`secret-box.ts`, `rate-limit.ts`, `email-domain.ts`, `authorize.ts`, `actor.ts`, `visibility.ts`,
`permissions/index.ts`, `domain/permissions.ts`, `domain/roles.ts`

**HTTP** `route-handler.ts`, `authenticated-route.ts`, `cookies.ts`, `dto.ts`, `file-response.ts`,
`request-stream.ts`, `api-response.ts`, `page-guard.ts`, `request-meta.ts`, `src/middleware.ts`

**Storage** `types.ts`, `registry.ts`, `index.ts`, `keys.ts`, `path-safety.ts`,
`google/{drive-auth,drive-config,drive-client,drive-errors,drive-health,google-drive-object-store}.ts`,
`local-provider.ts`, `local-object-store.ts`, `backup-status.ts`

**Jobs** all 13 `scripts/*.ts`, `scripts/db/2026-08-01-storage-provider-fields.ts`

**Tests** all 46 files by name; read in full: `architecture-boundaries`, and the security suite index

**Docs** `docs/phase-0/*`, `docs/storage-migration/*`, `gdrive.md`, `README.md`, `CHANGELOG.md`
