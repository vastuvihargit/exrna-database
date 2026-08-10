# Deployment readiness — Biotech Research Drive on Cloudflare

**Status: NOT READY.**

Not because anything migrated so far is wrong — every migrated module is implemented, tested
against a real D1 engine and a real MongoDB, and green — but because a Cloudflare Worker
deployment still has requirements this repository does not meet, and each is demonstrable rather
than speculative:

1. **Uploads cannot work in a Worker.** The pipeline streams to a local quarantine directory,
   reads the head back off disk to check the file signature, scans it, moves it to a local
   `originals` directory, and only *then* mirrors to Google Drive. Google Drive is a mirror
   after a local write. `docs/cloudflare-migration/16-phase-7-storage-audit.md` is the full
   classification.
2. **Two repositories still have no D1 implementation** and are reachable from a Worker:
   `inventory-item` (which blocks the inventory pages, and whose stock-movement feature is not
   implemented at all — §6.3) and `drive-sync` (the Drive change feed, background rather than
   request-path). `migration` and `storage-migration` also lack one and always will: they read
   the local filesystem by definition and must keep running on Node.
3. **No Mongo → D1 metadata migration tooling exists.** There is no loader, so no cutover can
   be rehearsed, let alone performed.

None of these is an external blocker. All three are repository work. §6 states what remains with
enough detail to plan it, and §7 lists the two things that genuinely need a human.

This document is written to be actionable rather than reassuring. §2 records what is done and
proven; §5 records defects found and fixed; §6 records what is left.

---

## 1. Target architecture

```
Browser
  └── Cloudflare Access  (Google Workspace IdP)   identity, verified server-side
        └── Cloudflare Worker  (OpenNext-built Next.js 15)
              ├── D1                     application metadata — the authoritative store
              ├── Google Shared Drive    file bytes; D1 holds metadata only
              └── Queues                 asynchronous delivery and Drive sync
```

MongoDB and the local object store remain the rollback path until cutover verification
completes. **No production flag has been changed by this work**: every `DATA_SOURCE_*` variable
is unset, and unset means MongoDB.

## 2. What is complete and proven

Each has a document in `docs/cloudflare-migration/` recording its design, its divergences from
MongoDB, and its verification.

| Module | Flag | Document |
|---|---|---|
| Worker / OpenNext compatibility | — | `01-phase-1-worker.md` |
| D1 schema and migrations 0000–0004 | — | `02-phase-2-d1-schema.md` |
| Users, departments | `_USERS`, `_DEPARTMENTS` | `03-…-module-1` |
| Roles, permissions | `_ROLES` | `04-…-module-2` |
| Projects, experiments | `_PROJECTS`, `_EXPERIMENTS` | `05-…-module-3` |
| ACL visibility, deny, expiry, inheritance | — | `06-…-module-4` |
| Folders | `_FOLDERS` | `07-…-module-5` |
| Files, metadata, tags, FTS | `_FILES` | `08-…-module-6` |
| Atomic folder+file moves | — | `09-…-module-7` |
| Atomic trash / restore / archive | — | `10-…-module-8` |
| File versions, atomic version writes | `_FILE_VERSIONS` | `11-…-module-9` |
| Search, stars, recent, saved searches | `_SEARCH` | `12-…-module-10` |
| Reviews and approvals | `_REVIEWS` | `13-…-module-11` |
| Audit trail | `_AUDIT_LOGS` | `14-…-module-12` |
| Sessions, organizations, notifications, flag matrix, Cloudflare Access | `_SESSIONS`, `_ORGANIZATIONS`, `_NOTIFICATIONS` | `15-…-module-13` |
| Storage audit (classification only) | — | `16-phase-7-storage-audit.md` |

## 3. Test results

Exactly as run, from the repository root, at the tip of `cloudflare-migration`.

| Gate | Command | Result |
|---|---|---|
| Full MongoDB suite | `npm run test:mongo` | **51 files, 768 tests passed** (192 s) |
| Full D1 suite | `npm run test:d1` | **17 files, 584 tests passed** (1844 s) |
| Typecheck | `npm run typecheck` | clean |
| Lint | `npm run lint` | clean |
| Worker production build | `npm run cf:build` | **passed** — bundle written to `.open-next/worker.js` |
| Worker preview | `npm run cf:preview` | **not run in this session** — see §3.2 |

The D1 suite is slow by design: `fileParallelism: false`, a real Miniflare/workerd SQLite per
file, and a real `mongod` per file for the parity blocks. It fails rather than skips when either
database is unavailable, because a run that quietly checked nothing reports the same green ticks
as one that checked everything.

### 3.1 What the newest suites assert

* `tests/d1/session-organization-repository.test.ts` — 42 tests. Each session-liveness predicate
  is defeated **individually**, because an implementation missing exactly one of them passes a
  combined test and is an authentication bypass.
* `tests/d1/notification-repository.test.ts` — 20 tests, both engines, including that
  deduplication does *not* over-reach: two identical notifications with no dedupe key must both
  survive.
* `tests/unit/cloudflare-access.test.ts` — 21 tests signing real RS256 tokens against a generated
  key pair. Refuses `alg: none`, HS256-with-the-public-key, a tampered payload, an unknown `kid`,
  another application's audience, another team's issuer, expired, not-yet-valid, and an
  unreachable certs endpoint.

### 3.2 Honest note on the Worker gates

`cf:build` **was** re-run after the module 13 changes and passed. That matters more than it
sounds: `env.worker.ts` gained two startup assertions and now imports `data-source.ts` and
`cloudflare-access.ts`, so the build is what proves neither pulled anything Node-only into the
Worker module graph.

`cf:preview` was **not** re-run. The earlier result is recorded in `01-phase-1-worker.md` and
should not be treated as current, because the new assertions run at boot: a preview started
without `CF_ACCESS_*` will now warn, and one started with `NODE_ENV=production` will refuse.
Re-establish it before relying on it.

## 4. What has *not* been verified

Stated plainly, because the absence of a result is not a pass.

* **No end-to-end test exists.** There is no Playwright suite and no `tests/e2e` content; the
  vitest config excludes that path. The scientist workflow in the brief has not been executed
  against a running application.
* **No live Google Drive call has been made.** Drive code is exercised against
  `tests/helpers/fake-drive.ts`. No credentials were available.
* **No live Cloudflare Access token has been verified.** The suite generates its own key pair.
* **No migration has been run**, dry or otherwise, because the metadata tooling does not exist.
* **No UI walkthrough** has been performed against a running application.

## 5. Defects found and fixed

Six, each reachable in code that had already shipped or been written.

### 5.1 D1 binds at most 100 parameters per statement — not 999

Comments across the D1 layer were written against SQLite's compile-time default of 999
(`MAX_BOUND_IDS = 500`, `MAX_ACTOR_PRINCIPALS = 200`). Measured against the real engine, D1
accepts 100 and refuses 101.

Reachable paths: the **Starred page** (`listStarred` hands up to 200 ids to `findByIds`), any
folder page at maximum page size, and every listing for an actor carrying ~90 principals —
because the principal list is bound inside the visibility predicate of every permission-aware
read.

Fixed by `src/server/db/d1-bindings.ts`, which renders `IN (SELECT value FROM json_each(?))` —
one bound parameter regardless of list length — applied across all D1 repositories and
`visibility.d1.ts`. `EXPLAIN QUERY PLAN` confirms the index is still used.
`tests/d1/bound-parameter-limit.test.ts` measures the ceiling rather than asserting a remembered
number.

### 5.2 File search dropped its text filter for punctuation-only queries

`file.repository.d1.ts` built its `MATCH` argument by escaping rather than extracting, and the
caller read `if (match) push(...)`. A search for `***` therefore applied **no filter** and
returned every file the actor could see — the user asked one question and was shown the answer
to another.

Fixed by `src/server/repositories/fts-query.ts`, which extracts word runs and returns `null` for
unsearchable input; callers turn that into *no results*, never *no filter*. The
phrase-per-word rule was itself found by a test: OR-ing tokens *within* a word made a search for
`S-1111` match `S-2222` on the shared `S`.

### 5.3 Mongo aggregates counted trashed files

Mongoose does not route `aggregate` through the soft-delete middleware, so `searchFacets` and
four of the five `projectContentBreakdown` figures counted trashed files while
`linkedToExperiment` — a `countDocuments`, and therefore hooked — did not. A facet chip reading
`qpcr (2)` beside a single result row discloses that a second file exists. Fixed on the Mongo
side and pinned on both engines.

### 5.4 The session sweep could not run at all

`deleteExpiredBefore` is new on both engines, because SQLite has no TTL index. The first D1
implementation issued a bare `DELETE` and failed on a foreign key: `login_history.session_id`
references `sessions.id` with no cascade, so *every session that was ever logged into* blocks its
own deletion. `sessions.rotated_from_id` does the same for rotated sessions.

Now detaches both references and deletes, all three statements in one `batch()`. Detaching rather
than cascading is deliberate: a login-history row is a security record that must outlive the
session it describes.

Found by a test. A sweep that crashes leaves expired sessions in the table for ever, and the only
symptom is a growing table nobody is watching.

### 5.5 `sparse: true` does not exclude an explicit `null`

The MongoDB deduplication index was first written `{ unique: true, sparse: true }`. Sparse
excludes documents where the field is *absent*; every inline-written notification stores an
explicit `dedupeKey: null` from the schema default. The index therefore covered all of them,
decided they were the same key, and **rejected the second notification anybody ever received**.
Now `partialFilterExpression: { dedupeKey: { $type: 'string' } }`.

### 5.6 A partial unique index breaks `ON CONFLICT` on SQLite

The D1 side was first given a matching partial index. SQLite matches `ON CONFLICT (col)` to an
index by comparing the columns *and* the WHERE clause, so it needs
`ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL` — and drizzle's SQLite builder emits its
`where` after `DO NOTHING`, which is the `DO UPDATE` position and a syntax error. The failure was
not on a duplicate; it was on the first insert.

Resolved by making the D1 index plain: SQLite treats every NULL in a unique index as distinct, so
`UNIQUE(dedupe_key)` already permits unlimited NULLs. The two engines legitimately need different
index shapes, and migration 0004 says why.

## 6. What remains

### 6.1 Uploads assume a local filesystem — the largest single item

Fully classified in `16-phase-7-storage-audit.md`. Summary: 17 `getStorageProvider()` call sites
across 7 files, of which **8 in `upload.service.ts` are blocking**; the rest are operational
paths a Worker does not run. Downloads and previews already resolve through
`getObjectStore(record.provider)` and work unchanged for Drive-backed records.

The Worker pipeline has to become: buffer the first 4 KB → signature check → reject early →
stream to a Drive resumable upload in a staging folder, hashing in a passthrough → verify size
and checksum → move staging → destination via `files.update` (a metadata change, not a byte
copy) → record.

`GOOGLE_DRIVE_STORAGE_ENABLED=true` is **not** sufficient today and setting it would be
misleading: it changes where bytes are mirrored to, not where they are first written.

### 6.2 Ten repositories have no D1 implementation

| Repository | Needed for | Blocking a Worker? |
|---|---|---|
| `upload-session` | uploading | yes |
| `inventory-item` | the inventory pages | yes |
| `comment` | file discussion | yes |
| `activity` | the "what happened here" timeline | yes |
| `storage-usage` | quota enforcement | yes |
| `login-history` | admin security view, and the login path writes it | yes |
| `app-setting` | runtime settings | yes |
| `drive-sync` | Drive change feed | background only |
| `migration` | the inbound Drive importer | Node-only tooling |
| `storage-migration` | byte-migration jobs | Node-only tooling |

The D1 schema already covers all of them. What is missing is the contract/Mongo/D1/façade split,
the tests and the flag wiring — the same shape as the thirteen modules already done. The last two
are *supposed* to run on Node and need no D1 implementation for cutover.

### 6.3 Inventory stock movement is not implemented at all

Worth separating from §6.2, because it is a feature gap rather than a migration gap. The brief's
Phase 5 asks for add-stock, issue-stock, employee/department/project/experiment linkage,
no-over-issue and immutable history. Today `inventory.service.ts` handles item *definitions* only
and says so: *"nothing here changes a quantity … stock moves only through the receipt, issue and
adjustment paths (Phase 2)"*, and those paths do not exist. There are two API routes, both item
CRUD.

The D1 schema anticipates the whole feature — `inventory_batches`, `stock_transactions`, the
`CHECK (quantity >= 0)` constraints and the append-only triggers are already there, and
`schema/inventory.ts` documents the conditional-UPDATE approach that replaces MongoDB's atomic
`findOneAndUpdate`. So the design decision is made; the implementation is not.

### 6.4 No Mongo → D1 metadata migration tooling

Nothing exists. `scripts/validate-acl-uniqueness.ts` is one validator; there is no reader, no
loader, no dry run, no count/sample/ACL comparison and no JSON report. This is Phase 9 in full,
across roughly twenty domains, and it is what makes a cutover rehearsable.

By contrast the **byte**-migration tooling (Phase 10) largely exists and is tested:
`services/storage-migration/` has a planner, runner, transfer, pending-transfer queue and
local-copy retention, with tests covering resume, idempotency ("adopts an object orphaned by a
crash instead of uploading a second one"), retry and rollback.

### 6.5 Cloudflare Access is verified but not wired to a route

`verifyAccessJwt` and `completeAccessLogin` exist and are tested. No route calls them, and
`resolveSession` still expects a session cookie. Wiring is a route handler plus a product
decision about whether Access replaces the login page or sits in front of it.

### 6.6 Everything downstream

Not started: Queue consumers (`wrangler.jsonc` declares producers only — deliberately, because a
consumer declared without a handler silently swallows messages), end-to-end tests, the UI
walkthrough against a running application, and the cutover runbook, which should not be written
as though it were runnable until §6.4 exists.

Much of the Phase 14 UI work is already done from earlier phases: the home page is no longer a
build tracker, the navigation carries no migration jargon, and the combined folder/file lifecycle
views are covered by module 10's tests. One remaining instance of build-phase jargon in the admin
role dialog ("Phase 3") was removed in this run.

## 7. Genuine external blockers

Only two things here need somebody outside this repository.

1. **Live credentials** — a Google Shared Drive id and service-account key, a Cloudflare account
   with D1 databases created, and an Access application. Everything they gate is *code-complete
   and mocked*; what is blocked is the live smoke test, not the implementation.
2. **A malware-scanning decision for the Worker.** `security/malware-scanner.ts` talks to clamd
   over TCP and workerd has no `net`. The three options — an HTTP scanning service, scanning
   asynchronously in a Queue consumer (which opens a window in which an infected file is
   downloadable), or accepting no scanning in a Worker and saying so on the admin page — differ
   in security posture, not in effort. **The code should not pick one silently.**

## 8. Required secrets

Names only. Set with `npx wrangler secret put <NAME> --env <development|staging|production>`.

```
AUTH_SECRET
SESSION_SECRET
GOOGLE_SHARED_DRIVE_ID
GOOGLE_SERVICE_ACCOUNT_EMAIL
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
GOOGLE_WORKSPACE_DOMAIN
CF_ACCESS_TEAM_DOMAIN
CF_ACCESS_AUD
```

`GOOGLE_DRIVE_ROOT_FOLDER_ID` is optional; without it content is written to the Shared Drive
root, which the admin page reports as a warning because a dedicated folder is easier to audit.

`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are **required in production** and `loadWorkerEnv`
refuses to boot without them — see §9.2. They must be set together: a team domain with no
audience verifies signatures and accepts any Access application's token on the same team.

`env.worker.ts` accepts both the short `GOOGLE_SERVICE_ACCOUNT_*` names and the longer
`GOOGLE_DRIVE_SERVICE_ACCOUNT_*` names the Node deployment uses, so one `.env` can feed both.
There is **no** file-based alternative in a Worker:
`GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE` reads from disk.

No real secret is in Git. `.dev.vars.example` carries names and empty values only.

## 9. Cloudflare configuration

### 9.1 Bindings

Declared in `wrangler.jsonc` for all three environments:

* **D1** — binding `DB`; `database_id` values are placeholders. Create with
  `npx wrangler d1 create biotech-drive-<env>` and paste the returned id.
* **Queues (producers)** — `SYNC_QUEUE`, `NOTIFICATION_QUEUE`.
* **Assets** — binding `ASSETS`.
* **Observability** — enabled; sampled at 0.2 in production.

Not declared, deliberately: queue **consumers**, dead-letter queues, retry policy, and any
`workflows` binding. A `workflows` binding requires the Worker entrypoint to export the workflow
class, and the OpenNext-generated entrypoint exports only the Next.js handler — declaring it
before the class exists makes every `wrangler dev` and every deploy fail.

Apply migrations with `npm run db:migrate:production` (or `:staging`, `:local`).

### 9.2 Access

* One Access application in front of the Worker's hostname, with Google Workspace as the IdP and
  a policy restricting to the company domain.
* `CF_ACCESS_AUD` is that application's Audience tag; `CF_ACCESS_TEAM_DOMAIN` is
  `<team>.cloudflareaccess.com`.
* The Worker verifies the JWT's signature, issuer, audience, `exp` and `nbf` server-side. It
  **never** trusts `Cf-Access-Authenticated-User-Email` — that header is plaintext and forgeable
  by anything that can reach the Worker directly, and a Worker URL is public.
* Access decides *identity*. Application roles still decide *capability*, and a verified token
  for a suspended account is refused by `completeOAuthLogin`.

## 10. Google Shared Drive configuration

* One **Shared Drive** owned by the company; the service account added as a **Content Manager
  member** of it.
* **No domain-wide delegation.** It would let the key impersonate any employee in the Workspace
  domain, turning a leaked environment variable into a full-domain compromise. Nothing here needs
  impersonation: the application ACL is authoritative.
* Scope `https://www.googleapis.com/auth/drive`, restricted in practice by that membership — the
  account can see exactly one Shared Drive.
* The logical structure `Company → Department → Project → Experiment → folders/files` is mirrored
  into Drive, but **application authorization never depends on Google folder permissions**, and a
  Drive file id is never treated as a capability.

## 11. Migration, cutover and rollback

The metadata tooling does not exist (§6.4), so the procedures are **not** reproduced here as
though they were runnable. Writing a runbook before the tooling exists produces a document that
looks like an instruction and is not one.

**Rollback today is trivial, and is the state the repository is in.** Every `DATA_SOURCE_*`
variable is unset, MongoDB serves every request, and the local object store holds every byte.
Reverting any module is deleting its variable; it takes effect on the next request, because the
flag is read per call and not cached at startup.

## 12. The data-source flag matrix

`DATA_SOURCE_DEPENDENCIES` in `src/server/repositories/data-source.ts` records every pair where
one module cannot be on D1 unless another is. Each entry is a **foreign key that exists in the D1
schema**, not a preference: a split pair does not degrade, it fails every write in the dependent
module on a constraint violation, at runtime, on a user's action.

`assertDataSourceMatrix()` runs inside both `loadEnv()` and `loadWorkerEnv()` and **refuses to
boot** on an unsafe combination, naming the exact pair. `dataSourceViolations()` returns all of
them rather than the first, because fixing one flag per restart cycle is how a cutover window
gets spent.

`workerReadinessGaps()` reports modules still on MongoDB: an error in a production Worker, a
warning otherwise so `cf:preview` can boot with a partial set.

Two flags are not independently movable, and both are runbook items rather than defects:

* `DATA_SOURCE_SESSIONS` — flipping it logs everybody out, because the new engine holds none of
  the existing sessions. It belongs inside the write freeze.
* `DATA_SOURCE_NOTIFICATIONS` — notifications written before the flip stop appearing until the
  migration copies them.

## 13. Known limitations

* `setCurrent()` on the version repository moves `file_versions.is_current` without touching
  `files.current_version_id`. Correct for its one caller, wrong for an upload; pinned by a test
  with a comment saying not to reach for it as a shortcut.
* The version validator's `missing_parent_file` check cannot be provoked on D1, because
  `file_versions.file_id` is a real foreign key. It stays because it targets a copy of the Mongo
  corpus loaded before constraints are enforced.
* `/api/health/ready` reports `storage.provider: "local"` because `health-service.ts` calls
  `getStorageProvider()`. Cosmetic today; actively misleading the moment a Worker is deployed.
  It should be fixed *with* the upload pipeline, not before — changing it in isolation would make
  the endpoint claim Drive on a deployment that still writes to disk.
* Audit records are written after the business commit rather than inside it, so a process death
  in the gap can lose an audit row. The alternative — writing inside the transaction — can record
  a success for a write that rolled back, which is worse.
* `stored-content.ts` has a local-copy fallback that throws in a Worker (no `local` provider
  registered) and is converted to the correct `NotFoundError` by the surrounding `catch`. The
  behaviour is right; the log line it would have written is not reached.
