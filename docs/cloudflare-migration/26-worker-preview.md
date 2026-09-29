# Worker preview verification (2026-09-29)

**Result: the production Worker bundle boots, passes its configuration gate, and serves every
module from D1 — authenticated reads and writes included — with the cron, queue and Durable
Object paths all executed.** Two defects were found and fixed on the way (§4); the bundle was
rebuilt and re-verified after the fixes.

The earlier preview in `01-phase-1-worker.md` §7 predates Access, the entrypoint, the queue
consumers and the startup checks, and should no longer be relied on.

---

## 1. What was run

```bash
npm run cf:build                                   # exit 0; .open-next/worker.js
npx wrangler deploy --dry-run --env staging --outdir <tmp>   # entrypoint bundles: 2.67 MB gzip
npx opennextjs-cloudflare preview --env development \
    --persist-to playwright-report/tmp/biotech-drive-e2e/d1
```

* **Entrypoint:** `cloudflare-worker.ts` (the configuration gate, queue consumers, cron
  handler and the `RateLimiter` Durable Object class), not OpenNext's bare `worker.js`.
* **Environment:** Wrangler `development` — `NODE_ENV=development`, `MALWARE_SCAN_MODE=disabled`
  (explicit), no Access (Access is only *required* in production; with `NODE_ENV=production` and
  no `CF_ACCESS_*` the gate refuses to boot, by design).
* **Data:** the local D1 the browser suite had just built — seeded MongoDB → `migrate:d1
  --write` → `migrate:verify` — plus everything the 34 E2E tests created (folders, files and
  versions, a review and its approval, inventory movements, audit rows).
* **Routing:** all 22 `DATA_SOURCE_*=d1`, added to `.dev.vars` for the run only.
* **Bindings, all local:** `DB` (D1), `SYNC_QUEUE`, `NOTIFICATION_QUEUE`, `RATE_LIMITER`
  (Durable Object), `ASSETS`.
* **Authentication:** password sign-in cannot work on a Worker (§4.1), and no Access application
  exists locally. For the authenticated checks one session row was inserted into that local D1
  for the seeded administrator, storing only the SHA-256 of a random token exactly as
  `issueSession` does; the token lived in a git-ignored scratch file and was deleted afterwards.
  Everything behind the cookie — session resolution, actor build, permission checks, D1 queries —
  is the real code path.

Startup: `{"msg":"Worker configuration accepted","nodeEnv":"development","access":false,"malwareScanMode":"disabled"}`.

## 2. Results

| Area | Request | Result |
|---|---|---|
| Health | `GET /api/health` | 200 |
| Readiness | `GET /api/health/ready` | 503, correctly: `database: ok (d1)`, `storage: ok (google_drive)`, `drive: error, connected: false` — no real Drive credentials exist locally |
| Auth boundary | `GET` folders, files, versions, search, reviews, inventory items + dashboard, drives, admin audit, storage-migration, drive import, local copies — no cookie | **401 `UNAUTHENTICATED`** for all 12 |
| Session | `GET /api/auth/session` | 200 — user, roles, permissions, storage |
| Drives | `GET /api/drives`, `/api/drives/my` | 200 |
| Folders | children of My Drive; **create** (201), read, **trash** (200) | D1 reads and writes on the Worker |
| Files | `GET /api/files/:id`, `/permissions` | 200 |
| File versions | `GET /api/files/:id/versions` | 200 — 2 versions |
| Reviews / approval | `GET /api/files/:id/reviews` (1), `/api/reviews`, `/api/approved` | 200 |
| Search | `GET /api/search?q=plate` | 200 — FTS on D1 |
| Recent, starred, notifications | | 200 |
| Inventory | items, dashboard, stock history (3 movements) | 200 |
| Admin | audit logs, system page | 200 |
| Sharing (write) | `POST /api/files/:id/permissions` | 200; the ACL shows the new entry |
| Node-only tools | storage migration, Drive import, local copies — signed in | **501 `NODE_ONLY_OPERATION`**, before any service runs |
| Internal queue route | `POST /api/internal/queues` without the in-process token | 404 |
| Password reset | `POST /api/auth/forgot-password` | 403 with the identity-provider recovery message |
| Password sign-in / change | `POST /api/auth/login`, `/change-password` | 403 `Sign-in is handled by your company single sign-on…` (after the §4.1 fix) |
| Pages (SSR) | `/home` (signed in), `/login` | 200 |

No request returned a 500 caused by Worker or module loading.

### 2.1 Durable Object rate limiting

Twelve failed sign-ins from one `CF-Connecting-IP`: attempts 1–10 were processed, 11 and 12
answered **429 `RATE_LIMITED` with `Retry-After: 899`**, and an attempt from another address was
not limited. The counter lives in the `RateLimiter` object, not the isolate.

### 2.2 Cron → queue → consumer

Triggered through `/cdn-cgi/handler/scheduled`:

| Cron | Enqueued | Consumed |
|---|---|---|
| `*/15 * * * *` | `drive.sync` | delivered; outcome **retry** (`QUEUE … 0/1`) — Drive is not connected locally, so this is the correct outcome, not a failure |
| `7 * * * *` | `uploads.cleanup`, `approvals.check` | both acked (`1/1`) |

The 03:07 UTC branch of the hourly cron (trash purge and inventory expiry sweep) is
time-dependent and was not triggered here; its selection logic is covered by
`tests/unit/queue-schedule.test.ts` and the sweep by `tests/d1/inventory-repository.test.ts`.

A share to a user enqueued a notification, which the notification consumer processed:
`{"queue":"notifications","received":1,"written":1,"msg":"Queue message processed"}`, acked.

## 3. What was not verified here

* **Cloudflare Access sign-in.** No Access application exists locally. The JWT verification is
  covered by `tests/unit/cloudflare-access.test.ts` and
  `tests/security/cloudflare-access-integration.test.ts`.
* **Any Google Drive call.** Uploads, downloads and the Drive sync need a real Shared Drive.
* **Live queues, DLQs and retry timing.** Wrangler's local queues run the same handler code;
  delivery guarantees and the dead-letter path belong to the platform.
* **Worker warn/error log lines.** `opennextjs-cloudflare preview` runs wrangler with stderr
  piped and prints it only if wrangler fails, so `console.warn`/`console.error` from the Worker
  do not appear during `cf:preview` (for example the startup warning that malware scanning is
  disabled). Plain `wrangler dev` shows them, and Workers Logs ingests `console.*` directly. To
  read them locally, run `npx wrangler dev --env development` after `cf:build`.

## 4. Defects found and fixed

### 4.1 Password sign-in on a Worker: 500s and a misleading "incorrect password"

The Argon2id hashes cannot be computed in workerd; `shims/argon2.worker.ts` throws. Sign-in was
refused up front only when Access was *enforced*, so on a Worker without Access:

* an **unknown address** answered **500** — the timing-equalisation hash threw;
* a **known address** answered "Incorrect email address or password" — which the *correct*
  password would also have received, because `verifyPassword` turns the throw into `false`.

Now `isPasswordAuthAvailable()` (`auth/access-session.ts`) is false behind Access **and on any
Worker**, like `isPasswordRecoveryAvailable()`. Sign-in and change-password answer 403 with the
single-sign-on message before any rate-limit counter or lookup; `/api/auth/providers` reports
`password: false`; an administrator setting a temporary password gets a validation message
instead of a 500. Tests: `tests/unit/password-auth-worker.test.ts`.

### 4.2 A record still on local disk downloaded as a truncated file

`registerProviders()` registered the `local` provider on every runtime. On workerd `node:fs` is an
empty in-memory filesystem, so the read *opened* and failed only after the 200 and
`Content-Length: 38` had been sent: the browser would save an empty or truncated file. The local
provider is now not registered on a Worker, so such a record fails as the registry's controlled
`STORAGE_ERROR` before any byte is sent. After cutover no record should point at local disk
(cutover step 12 verifies it); this makes the failure loud if one does. Tests:
`tests/unit/storage-registry.test.ts`.

## 5. Clean-up performed

* The whole Wrangler/workerd process tree was stopped (9 processes), and none remained.
* `.dev.vars` was restored from its backup; its SHA-256 matches the original, and it contains
  no `DATA_SOURCE_*` or `D1_LOCAL_PROXY_PERSIST` line.
* The session token file and probe scripts were deleted. The session row existed only in the
  E2E suite's scratch D1, which the next E2E run recreates from scratch.
