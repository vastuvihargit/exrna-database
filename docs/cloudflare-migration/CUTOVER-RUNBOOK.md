# Production cutover runbook: Node + MongoDB → Cloudflare Worker + D1 + Google Shared Drive

**Audience:** the operator running the cutover, with a second person checking each gate.
**Do not start** until every item in §0 is ticked. Every step has a pass condition: if it is not
met, **stop and go to `ROLLBACK-RUNBOOK.md`**. No step says "probably fine".

> **Switching sessions to D1 logs existing users out.** D1 holds only the sessions the migration
> copied at the final pass, and a Worker issues Access-backed sessions afresh anyway. The session
> and data-source switch (steps 15–16) therefore happens **only inside the maintenance window**,
> never before, and users are told in the announcement that they will have to sign in again.

Conventions:

* `$PROD` = `--env production`.
* **Node** = the current Docker deployment (`docker-compose.prod.yml`).
* **Worker** = the Cloudflare deployment.
* Record the UTC time of every step in the cutover log, and attach every report file.
* The exact commands for a *rehearsal* of this runbook on staging are in `REHEARSAL.md`.

---

## 0. Prerequisites: days before, not on the night

| # | Item | Proof |
|---|---|---|
| 0.1 | Every code gate green at the commit being deployed: `npm run typecheck`, `npm run lint`, `npm run test:mongo`, `npm run test:d1`, `npm run test:e2e`, `npm run cf:build` | CI (`ci.yml`) or terminal output attached to the cutover log |
| 0.2 | Production D1 created and its id pasted into `wrangler.jsonc` → `env.production.d1_databases[0].database_id`: `npx wrangler d1 create biotech-drive-production` | The id is no longer `00000000-…` |
| 0.3 | Schema applied: `npm run db:migrate:production` | `npx wrangler d1 migrations list biotech-drive-production $PROD --remote` shows 0000–0005 applied, nothing pending |
| 0.4 | Queues created: `biotech-drive-{sync,sync-dlq,notifications,notifications-dlq}-production` | `npx wrangler queues list` |
| 0.5 | Secrets set (names in `EXTERNAL-SETUP.md` §1.6): `npx wrangler secret put <NAME> $PROD` | `npx wrangler secret list $PROD` lists every name |
| 0.6 | Cloudflare Access application live for the production hostname (`22-cloudflare-access.md` §3) | A test user reaches the Worker's `/api/health` through Access |
| 0.7 | Malware-scanning provider chosen and `MALWARE_SCAN_MODE=http` (+ endpoint, secret) set, **or** `disabled` recorded as a signed-off business decision | Written decision in the cutover log |
| 0.8 | Every active employee has an account whose e-mail matches their Google Workspace address | `migrate:validate` output reviewed; five users spot-checked |
| 0.9 | **Bulk byte migration done:** every existing file version copied to the Shared Drive and verified (see step 8 for the procedure; run it in the days before) | A dry-run storage-migration job over everything reports `selected: 0` |
| 0.10 | Full rehearsal done on **staging** with a production snapshot: steps 1–20 end to end, **including a rollback** (`REHEARSAL.md`) | Rehearsal log with timings; use them to size the window |

Window budget = bulk load + final deltas + verification + smoke tests + 50 % contingency, from
the rehearsal timings.

---

## 1. Verify backups (T-60 min)

```bash
docker compose -f docker-compose.prod.yml exec backup sh /usr/local/bin/run-job.sh backup   # fresh backup now
docker compose -f docker-compose.prod.yml exec backup bash /usr/local/bin/restore.sh --list
mongodump --uri "$MONGODB_URI" --gzip --archive=cutover-pre.gz                            # rollback baseline
```

**Pass:** a backup completed within the last 15 minutes; the latest restore drill
(`verify-restore.sh`) is < 90 days old and green; the off-site copy exists; `cutover-pre.gz` is
stored **off the server**.

## 2. Enable maintenance / write freeze (T-0)

1. Users were told in advance, including "you will be signed out and must sign in again".
2. On **Node**, set `MAINTENANCE_MODE=read_only` in `.env` and restart the app container:
   `docker compose -f docker-compose.prod.yml up -d app`.

**Pass:** `POST /api/folders` answers **503** "read-only"; browsing and downloads still work;
`/api/health` is 200.

## 3. Stop new writes completely

1. Wait for in-flight uploads to finish. **Pass:** Admin → System shows 0 uploads in progress,
   or the remainder are past `INCOMPLETE_UPLOAD_RETENTION_HOURS`.
2. Stop the scheduler (every writing job lives there — `drive:sync`, `drive:drain`,
   `drive:check-approvals`, `purge:trash`, `cleanup:uploads`, `inventory:expire`, `monitor`):
   `docker compose -f docker-compose.prod.yml stop scheduler`.
   **Pass:** `docker compose -f docker-compose.prod.yml ps scheduler` shows it exited.
3. Set `MAINTENANCE_MODE=maintenance` and restart the app container.

**Pass:** every page shows "Scheduled maintenance"; `GET /api/files/…` answers 503;
`/api/health` is 200. Record **`FREEZE_AT`** = now (UTC, ISO 8601).

From here on MongoDB receives no writes. That is what makes the final delta (step 10) complete.

## 4. Validate the Mongo source

Operator machine, `MONGODB_URI` pointing at production with **read-only** credentials:

```bash
npm run migrate:validate
```

**Pass:** exit 0, `PASS — no blockers`. Advisory findings are read and accepted in the log.
**Stop** on any blocker.

## 5. Mongo → D1 dry run

Reads MongoDB, transforms every row, writes nothing (dry run is the default):

```bash
npm run migrate:d1 -- --env production --remote --run-id cutover-dry --report reports/cutover-dry.json
```

**Pass:** `"ok": true`, `totals.failed = 0`, every skip explained in `skips`. The per-step counts
are the numbers step 7 must reproduce.

## 6. Metadata migration

The bulk load **may** have been run earlier the same day, while the freeze was only `read_only`,
to shorten the window; then record its start time as `BULK_START` and go to step 7.

```bash
npm run migrate:d1 -- --env production --remote --write --confirm production \
  --run-id cutover-bulk --report reports/cutover-bulk.json
```

Record **`BULK_START`** (the time the command was started). If the run is interrupted, re-run
the same command with `--resume cutover-bulk`: it continues from the last committed page, and
every step is idempotent.

**Pass:** `"ok": true`, `totals.failed = 0`.

## 7. Verify counts, relationships and ACLs

```bash
npm run migrate:verify -- --env production --remote --acl-sample 1000 --fts-sample 100 \
  --report reports/cutover-verify-1.json
npm run acl:validate
```

Then spot-check one restricted folder: a user without access has no granting row.

```bash
npx wrangler d1 execute biotech-drive-production $PROD --remote --command \
  "SELECT principal_type, principal_id, access_level, deny FROM resource_permissions WHERE resource_id='<folderId>'"
```

**Pass:** exit 0, `PASS`; every count row `ok` (a difference equal to the explained skips from
step 6 is acceptable and written into the log); ACL sample 0 mismatches; `acl:validate` 0
findings.

## 8. Migrate / finalize Google Drive bytes

A Worker reads only Drive-backed versions, so **no version may still be local**. The bulk
transfer was done before the night (0.9). Tonight only the remainder is finalized.

The storage-migration **API** is POST-only and so is refused under the freeze. It is used
**before step 2** for the last pass:

```http
POST /api/admin/storage-migration                 { "name": "cutover-final", "mode": "dry_run", "selection": {} }
POST /api/admin/storage-migration/{id}/plan
# if selected > 0:
POST /api/admin/storage-migration                 { "name": "cutover-final-run", "mode": "migrate", "selection": {} }
POST /api/admin/storage-migration/{id}/run
POST /api/admin/storage-migration/{id}/verify
```

Repeat the dry run until it reports `selected: 0`. Anything uploaded after that is written to
Drive by Node's `DEFAULT_STORAGE_PROVIDER=google_drive` path; `read_only` then stops uploads.

Inside the window, drain whatever is still waiting (a CLI, so it runs under the freeze):

```bash
npm run drive:drain
```

**Pass:** Admin → System "Files waiting for the Shared Drive" = 0.

## 9. Verify checksums, sizes and Drive ids

```bash
npm run verify:storage   # every Drive object exists; size and checksum match its version row
```

**Pass:** 0 missing, 0 mismatched, 0 versions without a `google_drive_file_id`.

## 10. Final Mongo delta

Everything changed in MongoDB since the bulk load began — now complete, because writes stopped at
`FREEZE_AT`:

```bash
npm run migrate:d1 -- --env production --remote --write --confirm production \
  --since <BULK_START> --run-id cutover-delta --report reports/cutover-delta.json
```

**Pass:** `"ok": true`, `totals.failed = 0`.

## 11. Final Drive delta

Versions written after step 6 carry their Drive id only in MongoDB until the delta copies them.
Confirm D1 now sees every version as Drive-backed:

```bash
npm run migrate:verify -- --env production --remote --require-drive-storage --acl-sample 0 --fts-sample 0 \
  --report reports/cutover-verify-drive.json
```

**Pass:** no `versions-not-in-drive` finding; every `file_versions` row in D1 is `google_drive`.
**Stop** otherwise: roll back (nothing is lost — step 15 has not happened), finish the byte
migration, and re-run from step 2 on another night.

## 12. Verify file / version pointers

```bash
npm run migrate:verify -- --env production --remote --acl-sample 1000 --fts-sample 100 \
  --report reports/cutover-verify-final.json
```

This is the **final** full verification, after both deltas.
**Pass:** exit 0, `PASS`; no `version-*` findings: every `files.current_version_id` and
`files.approved_version_id` resolves, exactly one `is_current` version per file.

## 13. Verify reviews / approvals

From `reports/cutover-verify-final.json`: no `approval-*` / `review-*` findings — every approval
bound to its review's exact version.

**Pass:** 0 findings. The three most recent approvals are spot-checked in the UI at step 18.

## 14. Verify search

From the same report: every live file is in `files_fts` exactly once, and each sampled file is
found by its own name.

**Pass:** `ftsChecked` ≥ 100, no FTS findings.

## 15. Switch the `DATA_SOURCE_*` flags

On the **Worker** (`wrangler.jsonc` → `env.production.vars`), set **all 22 flags to `d1`**; the
list is in `DATA-SOURCE-FLAGS.md` §2. A production Worker refuses to boot with any of them
missing, so a partial switch cannot happen silently.

On **Node**, leave every flag unset. Node stays on MongoDB as the rollback target and is not
served to users after step 17.

## 16. Switch session / auth storage

* `DATA_SOURCE_SESSIONS=d1` is part of step 15. **Every user is signed out at this point.**
  That is expected, and it is why the step sits inside the window.
* Sign-in on the Worker is Cloudflare Access only (`CF_ACCESS_*` from 0.5). Password sign-in and
  the application's password reset are disabled there: the API answers `403 FORBIDDEN` with a
  message pointing to the identity provider's recovery, and `/forgot-password` and
  `/reset-password` show that message instead of a form (`isPasswordRecoveryAvailable`,
  `src/server/auth/access-session.ts`). Account recovery is Google Workspace's.
* Drive storage is enforced by `wrangler.jsonc` vars: `GOOGLE_DRIVE_STORAGE_ENABLED=true`,
  `DEFAULT_STORAGE_PROVIDER=google_drive`, `UPLOAD_STAGING=google_drive`. **Pass:** unchanged
  from the reviewed commit.

## 17. Deploy the Cloudflare Worker

```bash
npm run cf:build
npx opennextjs-cloudflare deploy --env production
```

Route the production hostname to the Worker (Custom Domain), behind the Access application.

**Pass:** the deploy succeeds; Workers Logs shows `Worker configuration accepted` with
`access: true` and the expected `malwareScanMode`, and **no** `fatal` line.

## 18. Smoke tests

Through Access, as a normal employee **and** as an administrator:

| Check | Pass |
|---|---|
| `GET /api/health/ready` | 200, database `d1`, Drive `connected` |
| Sign in via Access | lands on /home; `/api/auth/session` shows the right user and roles |
| My Drive, open a migrated folder | contents match MongoDB for three spot-checked folders |
| Download and preview a migrated file | bytes open; one file's checksum compared by hand |
| Upload a new file to a test folder | appears; malware scan logged (if enabled) |
| Upload version 2, request review, approve as a second user | approval shows on the reviewed version |
| Search for a migrated file by name, tag and sample id | found |
| Starred, Recent, Shared with me | populated |
| Inventory: open an item, view stock history | matches MongoDB |
| Notifications | the test review's notifications arrive (notification consumer working) |
| Audit log (admin) | today's test actions present |
| Trash and restore the test file | works |
| Workers Logs | no `error` / `fatal` from `worker-entry`; queue messages `ack`ed |

**Stop** and roll back on any failure affecting data correctness, access control or
authentication. Cosmetic issues are logged and fixed forward. Rollback up to here is lossless
(`ROLLBACK-RUNBOOK.md` §1).

## 19. Disable the maintenance / write freeze

Users are now let in — to the Worker. Node **stays running in `maintenance` mode**, unreachable by
users: it is the rollback target. Announce the end of the window.

Record **`CUTOVER_AT`** (UTC). The rollback window starts now.

## 20. Monitor

| When | What |
|---|---|
| First 2 h, continuously | Workers Logs: `level:error`/`fatal`; 5xx rate; queue backlog; `SERVICE_MISCONFIGURED` responses (must be 0) |
| Every 15 min, first day | Dead-letter queues are empty |
| Daily, first week | Admin → System: Drive connection, sync cursor advancing every 15 min, maintenance jobs acknowledged hourly (Workers Logs: `Queue message processed` with a `job` field), malware check, storage |
| Daily, first week | D1 size and row counts growing plausibly. `migrate:verify` is **not** re-run: MongoDB is stale by design now |
| Day 7 at the latest | Close the rollback window (`ROLLBACK-RUNBOOK.md` §4); keep the final MongoDB snapshot for 90 days |

A message in a DLQ: read it, fix the cause, replay it by re-sending its body to the main queue.
Consumers are idempotent (`23-worker-entrypoint-and-queues.md`).
