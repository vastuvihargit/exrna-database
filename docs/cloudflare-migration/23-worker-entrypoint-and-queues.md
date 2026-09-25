# Worker entrypoint, queue consumers and background writes

**Status: code complete, tested locally.** The consumers are unit- and integration-tested. The
entrypoint's batch handling is exercised in the Worker preview (`26-worker-preview.md`).

---

## 1. A finding that changed the scope: the startup checks were never running

`loadWorkerEnv()` is where the Worker's safety checks live:

* the `DATA_SOURCE_*` matrix;
* Access being required in production;
* D1 readiness;
* Drive-only storage;
* bindings present.

The previous readiness report said they "run at boot". **Nothing called `loadWorkerEnv()`.**
`wrangler.jsonc` pointed `main` straight at OpenNext's generated `.open-next/worker.js`, which
exports only `fetch`, and no module in the Next bundle imported `env.worker.ts`. A production
Worker with no Access, or with half the flags on MongoDB, would have booted and failed per request.

It is fixed by `cloudflare-worker.ts`, the new `main`.

## 2. `cloudflare-worker.ts`

| Handler | What it does |
|---|---|
| `fetch` | Runs `assertBindings` + `loadWorkerEnv` once per isolate. If they fail, every request gets a **503** with a generic body, and the reason is logged at `fatal` with `source: worker-entry`. If they pass, the request goes to the OpenNext handler, unchanged. |
| `queue` | Maps the queue name to `sync` or `notifications` and hands each message to the consumer (see §3). The consumer's outcome decides the call: `ack`, `retry({ delaySeconds })`, or `drop`, which is an ack plus an error log. A batch arriving while the configuration is rejected is retried as a whole, never lost. |
| `scheduled` | The cron trigger (`*/15 * * * *`). It enqueues one `drive.sync` message; it does not run the sync inline. |

The startup log line records the Access and malware-scanning configuration. A deployment running
with `MALWARE_SCAN_MODE=disabled` logs a `warn` saying so.

### 2.1 How a queue message reaches application code

The consumer needs the application: repositories, flags, the Drive client and the logger. All of
them live in the OpenNext-built bundle, which aliases the dependencies a Worker cannot load.
Importing them a second time into the entrypoint would bundle a second, un-aliased copy of the
server.

So the entrypoint calls the Next handler **in-process**: a `POST /api/internal/queues`,
authenticated by a random token that is generated inside the isolate and kept on `globalThis`
(`src/server/queues/internal-token.ts`).

* The token is not an environment variable, not a Cloudflare secret, and never appears in a
  response. A request from the internet cannot present it.
* The route answers 404 to anything without it, including a guessed value. It uses a
  constant-time comparison, performed before the body is parsed.
* On Node the token is never set, so the route is permanently 404.

## 3. Consumers (`src/server/queues/consumers.ts`)

**Principle: a message is a request to do work, never a grant of authority.** Payloads are
validated with strict, versioned zod schemas (`messages.ts`). Anything the consumer needs is
re-derived from the database.

### 3.1 Drive sync (`SYNC_QUEUE`)

* Message: `{ kind: 'drive.sync', trigger: 'cron' | 'manual', requestedAt }`. A message that
  tries to name an organization is refused, because of the strict schema.
* The consumer resolves the organization itself and runs one **bounded**
  `driveSyncService.syncDriveChanges` (10 pages × 100 changes). The cursor carries the rest to the
  next run.
* **Idempotent and duplicate-safe:** the cursor advances only after a page is applied, and every
  change application is idempotent (`drive-sync.service.ts` §header). A duplicate message is just
  another bounded run.
* **Outcomes:**
  * Drive storage off → `ack`, with a log line.
  * Sync error → `retry` after 60 s.
  * After `max_retries: 3` → `biotech-drive-sync-dlq-<env>`.
* `max_batch_size: 1`: two syncs in parallel would contend for one cursor for no gain.

### 3.2 Notifications (`NOTIFICATION_QUEUE`)

The need for this queue is concrete. Review requests, review decisions and comment notifications
were written with a detached `void notificationRepository.createMany(…)`. In a Worker a detached
promise can be cancelled once the response returns, so those notifications would sometimes never
exist.

* **Producer (`notification-dispatch.ts`):**
  * In a Worker, `dispatchNotifications` sends to `NOTIFICATION_QUEUE`, at most 50 notifications
    per message to stay inside the 128 KB cap.
  * On Node it writes inline, exactly as before.
  * All five producers now use it: review requested, review decided, comment, share, review
    reopened.
* **Idempotency:**
  * Every notification carries `dedupeKey = <eventKey>:<type>:<recipient>`, fixed before the
    message is sent.
  * Both engines turn a repeat into a no-op. The module 13 tests cover this on D1 and MongoDB.
  * The event key identifies one occurrence (`review-requested:<reviewId>`, `comment:<commentId>`,
    or a fresh UUID for a share), so two genuine events still produce two notifications.
* **Authorization:** the consumer re-checks that each recipient exists, is `active`, and belongs to
  the organization the message names. Anything else is skipped silently, which is the same answer
  the inline path would have given.
* **Outcomes:**
  * Malformed message, or a notification without a dedupe key → `drop`.
  * Database failure → `retry` with exponential backoff: 30 s, 60 s, 120 s … up to 15 min.
  * After `max_retries: 5` → `biotech-drive-notifications-dlq-<env>`.

### 3.3 Where failures become visible

* **Workers Logs:**
  * one structured line per outcome, with `queue`, `messageId` and `attempts`;
  * `warn` for a retry;
  * `error` for a drop;
  * `fatal` for a rejected configuration.
* **Dead-letter queues:** nothing consumes them automatically. An operator inspects them with
  `wrangler queues` and replays them after fixing the cause (see `CUTOVER-RUNBOOK.md`, "Monitor").
* **Drive-sync state** is still recorded by the service and shown on the admin System page.

## 4. Background writes: `detach()`

Fifteen other secondary writes were detached with `void … .catch(() => undefined)`:

* activity feed rows;
* "recent" entries;
* one **audit** record, for an upload being authorized;
* a saved search's last-run time.

They had the same Worker problem as the notifications. `src/server/runtime/detach.ts` keeps the
fire-and-forget shape, but registers the promise with `ctx.waitUntil` when a Cloudflare request
context is present, and logs a failure instead of swallowing it. Node behaviour is unchanged.

## 4a. Three more Worker paths that still reached for MongoDB

These were found while tracing the E2E flow through the Worker. Each would have failed after
cutover **with every module correctly on D1**, because Mongoose needs a TCP socket and workerd has
none:

| Path | What happened | Fix |
|---|---|---|
| `withTransaction()` around upload finalize, new version, file move / trash / restore, copy, approval integrity | Opened a MongoDB session even when the D1 branch inside the block used a D1 `batch()` and ignored the session. **Uploads would have failed.** | In a Worker the callback runs with no session (`db/connection.ts`) |
| `drive-mirror.ts`: `driveObjectsForFile`, `driveFolderFor` | Queried `FileVersionModel` and `FolderModel` directly during file and folder move, trash and restore | Now read through `versionRepository` / `folderRepository`. The unused `driveObjectsUnderFolder` was removed. |
| `checkDatabaseHealth()`, which feeds `/api/health/ready` and admin → System | Pinged MongoDB, so **every healthy Worker would report its database as down** | A D1 `SELECT 1` in a Worker |

`system.service` also stops asking for the Node byte-migration counters (pending transfers,
retained local copies) in a Worker, where the concepts do not exist.

`tests/unit/worker-mongo-free-paths.test.ts` pins all three.

## 5. Configuration (`wrangler.jsonc`)

Declared identically for `development`, `staging` and `production`, and for the top-level default:

* producers `SYNC_QUEUE` and `NOTIFICATION_QUEUE`, unchanged;
* consumers with retry limits and dead-letter queues;
* `triggers.crons: ["*/15 * * * *"]`.

**Queues to create per environment (external action):**

```
npx wrangler queues create biotech-drive-sync-<env>
npx wrangler queues create biotech-drive-sync-dlq-<env>
npx wrangler queues create biotech-drive-notifications-<env>
npx wrangler queues create biotech-drive-notifications-dlq-<env>
```

No other queue was added. The `workflows` binding stays undeclared: the metadata migration runs
from an operator's machine through `wrangler d1 execute`, not as a Workflow.

## 6. Verification

| Test | Result |
|---|---|
| `tests/integration/queue-consumers.test.ts` (new) | **12 passed** |
| `tests/unit/detach.test.ts` (new) | 2 passed |
| `tests/unit/route-protection.test.ts`, internal-route structure | passed |
| `tests/d1/notification-repository.test.ts` (existing): dedupe on both engines | unchanged, passing |

## 7. Rollback

Point `main` back at `.open-next/worker.js` and remove the `consumers` and `triggers` blocks. Queued
messages then wait (they are not lost) until a consumer returns. `dispatchNotifications` needs no
rollback on Node, where it writes inline exactly as before.
