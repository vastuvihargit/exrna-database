# Production configuration: audit and required values

Audited files:

* `wrangler.jsonc`
* `.dev.vars.example`
* `.env.example`
* `src/server/config/env.ts` (the Node schema, also read inside the Worker via `process.env`)
* `src/server/config/env.worker.ts` (the Worker gate, run by `cloudflare-worker.ts`)
* `cloudflare-worker.ts`

**No secret values are in the repository.** `.dev.vars` and `.env` are git-ignored, and the example
files carry names and empty values only.

## 1. Production blockers in `wrangler.jsonc`

| Item | State | Action |
|---|---|---|
| `d1_databases[].database_id` (all environments) | **PLACEHOLDER `00000000-0000-0000-0000-000000000000`**, marked in the file | `npx wrangler d1 create biotech-drive-<env>`, then paste the id. Acceptable locally: `wrangler dev --local` ignores it. |
| Queues | Declared, but they must exist in the account | `npx wrangler queues create` for the four names per environment (§2.2) |
| `MALWARE_SCAN_MODE` for staging and production | **Deliberately unset**: the Worker refuses to boot | Set once the provider decision is made (`24-malware-scanning.md`) |
| Custom domain / route | Not declared | Add the production hostname (`routes` / Custom Domains) once DNS is decided; `workers_dev` is already `false` for production |

**Always deploy with an explicit environment** (`--env production`). The top-level block exists
for local `wrangler dev` and points at the *development* database name with `NODE_ENV=production`.
Deploying it would give a production-mode Worker bound to the dev D1.

## 2. Bindings

### 2.1 Names the code expects (checked at boot by `assertBindings`)

| Binding | Type | Used by |
|---|---|---|
| `DB` | D1 | every repository (`db/d1-context.ts`), health check |
| `SYNC_QUEUE` | Queue producer | cron → Drive sync |
| `NOTIFICATION_QUEUE` | Queue producer | `dispatchNotifications` |
| `ASSETS` | Static assets | OpenNext |

### 2.2 Resources per environment (`<env>` = `dev` | `staging` | `production`)

| Resource | Name |
|---|---|
| D1 database | `biotech-drive-<env>` |
| Queue | `biotech-drive-sync-<env>` (consumer: this Worker, batch 1, 3 retries) |
| Queue | `biotech-drive-sync-dlq-<env>` (dead letters; no consumer) |
| Queue | `biotech-drive-notifications-<env>` (consumer: this Worker, batch 10, 5 retries) |
| Queue | `biotech-drive-notifications-dlq-<env>` (dead letters; no consumer) |
| Cron trigger | `*/15 * * * *` → enqueue a Drive sync |
| Access application | one per public hostname (`22-cloudflare-access.md`) |

## 3. Required secrets, by name only

Set with `npx wrangler secret put <NAME> --env production`, and the same for staging.

| Name | Required | Notes |
|---|---|---|
| `AUTH_SECRET` | yes | ≥ 32 characters |
| `SESSION_SECRET` | yes | ≥ 32 characters, **different** from `AUTH_SECRET` in production |
| `APP_URL` | yes | `https://…`; `http://` is refused in production. May be a var instead. |
| `COMPANY_EMAIL_DOMAINS` | yes | comma-separated. May be a var. |
| `GOOGLE_SHARED_DRIVE_ID` | yes | |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | recommended | without it content lands in the Shared Drive root (warning on the admin page) |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | yes | alias accepted: `GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL` |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | yes | full PEM on one line, `\n`-escaped; alias `GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY` |
| `GOOGLE_WORKSPACE_DOMAIN` | yes | |
| `CF_ACCESS_TEAM_DOMAIN` | **yes in production** | `<team>.cloudflareaccess.com`; must be set together with the AUD |
| `CF_ACCESS_AUD` | **yes in production** | the Access application's Audience tag |
| `MALWARE_SCAN_SECRET` | when `MALWARE_SCAN_MODE=http` | ≥ 16 characters |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | **not needed on the Worker** | Google OAuth sign-in is closed while Access is configured. They remain Node-only. |

Non-secret vars already in `wrangler.jsonc` for every environment:

* `NODE_ENV`, `APP_NAME`, `LOG_LEVEL`;
* `GOOGLE_DRIVE_STORAGE_ENABLED=true`, `DEFAULT_STORAGE_PROVIDER=google_drive`,
  `UPLOAD_STAGING=google_drive`.

Vars still to add per environment:

* `MALWARE_SCAN_MODE`, `MALWARE_SCAN_ENDPOINT`;
* the 24 `DATA_SOURCE_*=d1` flags (`DATA-SOURCE-FLAGS.md`), at cutover step 13;
* `MAINTENANCE_MODE`, only when needed.

## 4. What the Worker refuses at boot

`cloudflare-worker.ts` → `loadWorkerEnv()`. Refusal = 503 on every request, plus one `fatal` log
line with the reason. It refuses:

* a missing `DB`, `SYNC_QUEUE` or `NOTIFICATION_QUEUE` binding;
* a missing or short `AUTH_SECRET` or `SESSION_SECRET`, or (in production) the two being equal;
* `APP_URL` on `http://` in production;
* Drive not configured, `UPLOAD_STAGING` or `DEFAULT_STORAGE_PROVIDER` other than `google_drive`;
* production with no Access; half an Access configuration anywhere;
* `MALWARE_SCAN_MODE` unset or `clamav`; `http` without an endpoint (https in production) and a
  16+ character secret;
* an unknown `MAINTENANCE_MODE`;
* an unsafe `DATA_SOURCE_*` split (foreign-key or move-together); in production, any module not
  on D1.

## 5. Findings fixed during this audit

* The Worker gate above was **never executed**: `main` pointed at OpenNext's output directly. It
  is now wired through `cloudflare-worker.ts`.
* `.dev.vars.example` claimed `files` had no D1 implementation and listed eleven flags. It now
  lists all 24 and points at the matrix.
* `wrangler.jsonc`:
  * no consumers, DLQs or cron (added);
  * production allowed `*.workers.dev` (disabled);
  * the secrets comment omitted `CF_ACCESS_*` and the scanner (added).
* The readiness probe pinged MongoDB in a Worker (now D1). See `23-…` §4a for the other Worker
  paths fixed.

## 6. Google Shared Drive (unchanged, restated)

* One Shared Drive, owned by the company.
* The service account is a **Content Manager member** of that Drive.
* **No domain-wide delegation.**
* Scope `https://www.googleapis.com/auth/drive`.
* Application authorization never depends on Drive folder permissions.
