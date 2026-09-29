# Deployment readiness — Biotech Research Drive on Cloudflare

**Status: READY FOR PRODUCTION REHEARSAL** — as of 2026-09-29, branch `cloudflare-migration`.

That means exactly this: the locally implementable code is complete, every test suite is green,
the Worker builds and serves in a local preview, the migration tooling is ready and has been run,
and the cutover and rollback runbooks are written. **What remains needs things this repository
cannot provide**: live Cloudflare and Google resources, a malware-scanning decision, and a
rehearsal on a real production snapshot (§6).

It does **not** mean production is live, or production-ready. No production resource exists, no
production flag has changed, no live Google Drive or Cloudflare Access call has been made, and
no migration has touched real data.

---

## 1. Target architecture

```
Browser
  └── Cloudflare Access  (Google Workspace IdP)   identity, verified server-side (JWT)
        └── Cloudflare Worker  (OpenNext-built Next.js 15, entry: cloudflare-worker.ts)
              ├── D1                     application metadata — the authoritative store
              ├── Google Shared Drive    file bytes; D1 holds metadata only
              ├── Queues                 Drive sync + notifications (with DLQs), fed by two crons
              └── Durable Object         RATE_LIMITER — exact counters across isolates
```

The legacy Node + MongoDB + local-disk deployment remains production until cutover and the
rollback target after it. Every `DATA_SOURCE_*` is unset in every committed configuration.

## 2. Gate results

Run on 2026-09-29 at the tip of `cloudflare-migration`, on the development machine (Windows 11,
8 GB), one heavy job at a time.

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | clean |
| Lint | `npm run lint` | clean |
| MongoDB suites | `npm run test:mongo` | **69 files, 938 tests passed** (261 s) |
| D1 suites | `npm run test:d1` | __D1_RESULT__ |
| Browser E2E | `npm run test:e2e` | __E2E_RESULT__ |
| Drizzle metadata | `npx drizzle-kit generate` | "No schema changes, nothing to migrate" — journal 0000–0005 |
| Worker build | `npm run cf:build` | exit 0; entrypoint bundles (`wrangler deploy --dry-run`) at 2.67 MB gzip |
| Worker preview | `opennextjs-cloudflare preview --env development` | serving; details in `26-worker-preview.md` |
| Source validation | `npm run migrate:validate` (development MongoDB) | PASS — no blockers |
| Migration dry run | `npm run migrate:d1` (development MongoDB → scratch local D1) | 33 steps, 295 read, 295 would-write, 0 skipped, 0 failed; nothing written |
| Migration write + verify | E2E global setup: `migrate:d1 --write` + `migrate:verify` on seeded data | ok on every E2E run |

The focused suites the task list names are inside those runs: security (`tests/security/`,
including `cloudflare-access-integration`), Access (`tests/unit/cloudflare-access.test.ts`),
queues (`tests/unit/queue-schedule.test.ts`, `tests/integration/queue-consumers.test.ts`),
inventory (`tests/unit/inventory-domain.test.ts`, `tests/security/inventory-permissions.test.ts`,
and stock movement plus the expiry sweep on both engines in `tests/d1/inventory-repository.test.ts`),
migration (`tests/d1/mongo-to-d1-migration.test.ts`, `tests/unit/migration-gateway.test.ts`).

### 2.1 What the Worker preview established

Against a local D1 holding migrated data plus everything the E2E suite created, with every module
routed to D1: health 200; every protected route 401 `UNAUTHENTICATED` without a session; with a
session, folders, files, file versions, search, reviews/approvals, inventory, notifications and
admin all 200, including D1 **writes** (create/trash a folder, share a file); the three Node-only
tools 501 `NODE_ONLY_OPERATION`; the Durable Object limiter returning 429 with `Retry-After` after
ten attempts; both crons enqueuing their work and both queue consumers processing it. No request
returned a 500 from Worker or module loading. Not verified there: Access sign-in, any Drive call,
live queues/DLQs (`26-worker-preview.md` §3).

## 3. Defects found in this verification pass

All found by running the gates, all fixed with a test that fails without the fix:

| Defect | Severity | Doc |
|---|---|---|
| Confidential projects visible below clearance through role scope (both engines) | security | `25-browser-e2e.md` §5 |
| Per-IP sign-in limit keyed on a client-written `X-Forwarded-For` | security | `docs/security/hardening.md` |
| Overlapping D1 expiry sweeps wrote the same stock off twice | data integrity | `18-…-module-15` §4 |
| Revoked session → redirect loop, sign-in page unreachable | availability | `25-browser-e2e.md` §5 |
| Password sign-in on a Worker: 500 / misleading "incorrect password" | correctness | `26-worker-preview.md` §4.1 |
| Local-disk record on a Worker downloaded as a truncated file | data integrity | `26-worker-preview.md` §4.2 |
| Employee table re-render loop hung the *Add employee* pickers | UI | `25-browser-e2e.md` §5 |

Earlier defects (the ObjectId/UUID validator, D1's 100-parameter limit, FTS filter dropping,
trashed files in aggregates, the session sweep, notification dedupe indexes) are recorded in the
module documents 03–19.

## 4. Status of every production-readiness item

| Item | State | Where |
|---|---|---|
| All repositories on D1 behind flags (22 `DATA_SOURCE_*`) | done; no flag without a reader (test-enforced) | `DATA-SOURCE-FLAGS.md` |
| Unsafe flag combinations | refused at boot, all violations listed | `DATA-SOURCE-FLAGS.md` §3 |
| Uploads on a Worker (Drive staging) | done | `20-phase-7-worker-uploads.md` |
| Mongo → D1 migration tooling (validate, migrate, resume, delta, verify) | done, dry-run and write-verified locally | `21-phase-9-mongo-to-d1-migration.md` |
| Cloudflare Access sign-in, JWT verified server-side | done | `22-cloudflare-access.md` |
| Worker entrypoint: configuration gate, queue consumers, crons, DLQs | done | `23-worker-entrypoint-and-queues.md` |
| Rate limiting on the Worker | Durable Object, exact across isolates | `docs/security/hardening.md` |
| Inventory expiry sweep | daily via the 03:07 cron → queue; idempotent (now also under overlap) | `18-…-module-15` |
| Node-only admin tools on a Worker | 501 `NODE_ONLY_OPERATION`; tabs hidden | `node-only.ts` |
| Password reset / sign-in / change on a Worker | refused, pointing to the identity provider | `26-worker-preview.md` §4.1 |
| Malware scanning boundary | `http` (fail-closed on Workers and staging) or explicit `disabled`; staging/production refuse to boot unset | `24-malware-scanning.md` |
| Drizzle metadata | journal + snapshot through 0005; `db:generate` no-op; CI drift gate | — |
| Browser E2E | green | `25-browser-e2e.md` |
| Worker preview | verified | `26-worker-preview.md` |
| CI | typecheck, lint, drift check, Mongo + D1 suites, legacy build, Worker build + dry-run bundle, E2E; no job deploys production | `.github/workflows/ci.yml` |
| Deployment | staging Worker: manual workflow; production: runbook step 17, by an operator | `deploy-cloudflare.yml`, `CUTOVER-RUNBOOK.md` |
| Cutover runbook (20 steps, maintenance window, session logout) | written | `CUTOVER-RUNBOOK.md` |
| Rollback runbook (incl. reconciling D1-only writes) | written | `ROLLBACK-RUNBOOK.md` |
| External setup checklist | written | `EXTERNAL-SETUP.md` |
| Rehearsal commands | written | `REHEARSAL.md` |

## 5. Known limitations (accepted, documented)

* **Switching `DATA_SOURCE_SESSIONS` signs everyone out** — the new store holds none of the
  existing sessions. It happens inside the maintenance window (cutover step 16).
* **Clearance is per person, not per grant.** `actorClearance` is the highest over all of an
  actor's grants, and authorization, file/folder filters and now project visibility all use it
  that way. Someone cleared to `confidential` in one department sees `confidential` material in
  another department where they hold any grant. This is the long-standing model, not a
  regression; changing it is a product decision.
* `setCurrent()` on the version repository moves `file_versions.is_current` without touching
  `files.current_version_id` — correct for its one caller; pinned by a test.
* Audit records are written after the business commit, so a process death in the gap can lose an
  audit row (the alternative can record a success for a write that rolled back).
* On a Worker, a record still pointing at local disk fails with `STORAGE_ERROR`. After cutover
  none should exist (cutover step 12 checks).
* `cf:preview` hides the Worker's `console.warn`/`console.error` (OpenNext pipes wrangler's
  stderr); use `wrangler dev` to read them locally. Workers Logs captures them in production.
* This machine had < 4 GB free disk during verification; Windows Storage Sense emptied `%TEMP%`
  mid-run, so the heavy runs used a project-local `TEMP` (`25-browser-e2e.md` §3).

## 6. What remains, and who does it

### 6.1 External infrastructure (`EXTERNAL-SETUP.md` has the exact steps)

**Cloudflare:** D1 databases for staging and production and their real `database_id`s in
`wrangler.jsonc` (all three are the all-zero placeholder today); the sync and notification queues
and their two DLQs per environment; the Access application (Google Workspace IdP, company-domain
policy) and its audience tag; the hostname/custom domain; the Worker secrets.

**Google:** the Shared Drive and its root folder; a service account added as **Content Manager**
(no domain-wide delegation); the Workspace domain.

**Secrets** (names only; set with `wrangler secret put <NAME> --env <env>`): `AUTH_SECRET`,
`SESSION_SECRET`, `APP_URL`, `COMPANY_EMAIL_DOMAINS`, `GOOGLE_SHARED_DRIVE_ID`,
`GOOGLE_DRIVE_ROOT_FOLDER_ID` (recommended), `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_WORKSPACE_DOMAIN`, `CF_ACCESS_TEAM_DOMAIN`,
`CF_ACCESS_AUD`, `MALWARE_SCAN_SECRET` (with `http` mode). Vars: `MALWARE_SCAN_MODE`,
`MALWARE_SCAN_ENDPOINT`, and the 22 `DATA_SOURCE_*=d1` at cutover step 15. CI needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the `staging` GitHub environment.

### 6.2 A business decision

**The malware scanner.** `MALWARE_SCAN_MODE=http` needs a scanning service the company chooses
(endpoint + secret); `disabled` needs someone to accept running without scanning, in writing.
Staging and production Workers refuse to boot until one is set. Options and trade-offs:
`EXTERNAL-SETUP.md` §4, `24-malware-scanning.md`.

### 6.3 The rehearsal

On a production snapshot, against staging: `REHEARSAL.md` has the exact commands — backup,
validate, D1 migrations, dry run, write, verify, Drive migration and finalisation, resume, final
deltas, smoke tests, and a rollback drill. Only after a clean rehearsal is the cutover
(`CUTOVER-RUNBOOK.md`) scheduled.
