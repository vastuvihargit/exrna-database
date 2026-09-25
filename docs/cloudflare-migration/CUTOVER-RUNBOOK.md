# Production cutover runbook: Node + MongoDB → Cloudflare Worker + D1 + Google Shared Drive

**Audience:** the operator running the cutover, with a second person checking each gate.
**Do not start** until every item in §0 is ticked. Every step has a pass condition: if it is not
met, **stop and go to `ROLLBACK-RUNBOOK.md`**. No step says "probably fine".

> **Switching sessions to D1 logs existing users out.** D1 holds only the sessions the migration
> copied at the final pass, and a Worker issues Access-backed sessions afresh anyway. The session
> switch therefore happens **only** inside the maintenance window (steps 13–14), never before.

Conventions:

* `$PROD` = `--env production`.
* **Node** = the current Docker deployment (`docker-compose.prod.yml`).
* **Worker** = the Cloudflare deployment.
* Record the UTC time of every step in the cutover log.

---

## 0. Prerequisites: days before, not on the night

| # | Item | Proof |
|---|---|---|
| 0.1 | Every code gate green at the commit being deployed: `npm run typecheck`, `npm run lint`, `npm run test:mongo`, `npm run test:d1`, `npm run test:e2e`, `npm run cf:build` | CI or terminal output attached to the cutover log |
| 0.2 | Production D1 created, and its id pasted into `wrangler.jsonc` → `env.production.d1_databases[0].database_id`: `npx wrangler d1 create biotech-drive-production` | The id is no longer `00000000-…` |
| 0.3 | Schema applied: `npm run db:migrate:production` | `npx wrangler d1 migrations list biotech-drive-production $PROD --remote` shows 0000–0005 applied |
| 0.4 | Queues created: `biotech-drive-{sync,sync-dlq,notifications,notifications-dlq}-production` | `npx wrangler queues list` |
| 0.5 | Secrets set (names in `PRODUCTION-CONFIG.md` §3): `npx wrangler secret put <NAME> $PROD` | `npx wrangler secret list $PROD` lists every name |
| 0.6 | Cloudflare Access application live for the production hostname (`22-cloudflare-access.md` §3). The AUD tag and team domain are in the secrets. | A test user reaches the Worker's `/api/health` through Access |
| 0.7 | Malware-scanning provider chosen, and `MALWARE_SCAN_MODE` (+ endpoint/secret) set for production, **or** `disabled` recorded as a signed-off business decision | Written decision in the cutover log |
| 0.8 | Every active employee has an application account whose e-mail matches their Google Workspace address | `migrate:validate` output reviewed. Spot-check five users. |
| 0.9 | **Byte migration complete:** every file version is in the Shared Drive. A Worker has no local storage. | A dry-run storage-migration job over *everything* reports `selected: 0`. The final check is in step 7. |
| 0.10 | Full rehearsal done on **staging** with a production snapshot: steps 1–17 end to end, including a rollback | Rehearsal log with the timings; use them to size the window |

The rehearsal (0.10) sizes the maintenance window. Budget: bulk load + final delta +
verification + smoke tests + 50 % contingency.

---

## 1. Verify backups (T-60 min)

```bash
docker compose -f docker-compose.prod.yml exec backup sh /usr/local/bin/run-job.sh backup   # fresh backup now
docker compose -f docker-compose.prod.yml exec backup bash /usr/local/bin/restore.sh --list
```

**Pass:** a backup completed within the last 15 minutes, the latest restore drill
(`verify-restore.sh`) is < 90 days old and green, and the off-site copy exists.
**Then:** take an **extra MongoDB snapshot** (`mongodump --gzip --archive=cutover-pre.gz`) and
store it outside the server. It is the rollback baseline.

## 2. Enter the write freeze (T-0)

1. Announce the window to users (banner or e-mail, sent in advance).
2. On **Node**, set `MAINTENANCE_MODE=read_only` in `.env` and restart the app container:
   `docker compose -f docker-compose.prod.yml up -d app`.

**Pass:** `POST /api/folders` answers **503** "read-only"; browsing and downloads still work;
`/api/health` is 200.

## 3. Stop new writes completely

1. Wait for in-flight uploads to finish. **Pass:** the admin System page shows 0 uploads in
   progress, or they are past `INCOMPLETE_UPLOAD_RETENTION_HOURS`.
2. Stop every writing scheduled job on Node (`drive:sync`, `drive:drain`, `drive:check-approvals`,
   `purge:trash`, `cleanup:uploads`, `verify:storage`, `monitor`, all in `docker/scheduler/crontab`):
   `docker compose -f docker-compose.prod.yml stop scheduler`.
   **Pass:** `docker compose -f docker-compose.prod.yml ps scheduler` shows it exited.
3. Set `MAINTENANCE_MODE=maintenance` and restart the app container.

**Pass:** every page shows "Scheduled maintenance"; `GET /api/files/...` answers 503;
`/api/health` is 200. Record **`FREEZE_AT`** = now (UTC, ISO 8601).

From here on MongoDB receives no writes. That is what makes the final pass complete.

## 4. Validate the Mongo source

```bash
npm run migrate:validate
```

Run from the operator machine, with `MONGODB_URI` pointing at production and read-only
credentials.

**Pass:** exit 0, `PASS — no blockers`. Advisory findings are read and accepted in the log.
**Stop** on any blocker.

## 5. Run the Mongo → D1 migration

The bulk load *may* have been run earlier the same day, while the freeze was only `read_only`,
to shorten the window. If so, run only the delta, from 5.2.

```bash
# 5.1 bulk load (skip if already done today)
npm run migrate:d1 -- --env production --remote --write --confirm production \
  --run-id cutover-bulk --report reports/cutover-bulk.json

# 5.2 final delta: everything changed since the bulk load started, now that writes have stopped
npm run migrate:d1 -- --env production --remote --write --confirm production \
  --since <BULK_START_ISO> --run-id cutover-delta --report reports/cutover-delta.json
```

If a run is interrupted, re-run the **same command with `--resume <run-id>`**. It continues from
the last committed page. Every step is idempotent.

**Pass:** both reports have `"ok": true`, `totals.failed = 0`, and every skip is explained (read
`skips` in the JSON). **Stop** on any failure.

## 6. Run migration verification

```bash
npm run migrate:verify -- --env production --remote --acl-sample 1000 --fts-sample 100 \
  --report reports/cutover-verify.json
```

**Pass:** exit 0, `PASS`, every count row `ok`, no `error` findings. A count difference equal to
the number of explained skips from step 5 is acceptable and is written into the log.

## 7. Drive byte migration: final delta

A Worker can read only Drive-backed versions, so **no version may still be local**. The byte
transfer is driven through the admin storage-migration API, which is POST-only and therefore
refused under the freeze. So the transfer finishes **before step 2**, and inside the window it is
only *verified*.

**Before step 2 (still open for writes):**

```http
POST /api/admin/storage-migration      { "name": "cutover-final", "mode": "dry_run", "selection": {} }
POST /api/admin/storage-migration/{id}/plan
```

If `selected > 0`: create a `migrate` job with the same selection, `run` it and `verify` it,
then `npm run drive:drain` until *Files waiting for the Shared Drive* is 0. Repeat the dry run
until it reports `selected: 0`. New uploads made after this point are written to Drive by the
Node deployment's `DEFAULT_STORAGE_PROVIDER=google_drive` path and drained, and `read_only` stops
further uploads.

**Inside the window (read-only on both databases):**

```bash
npm run migrate:verify -- --env production --remote --require-drive-storage --acl-sample 0 --fts-sample 0
```

**Pass:** no `versions-not-in-drive` finding; every `file_versions` row in D1 is
`google_drive`. **Stop** otherwise: roll back, finish the byte migration, and re-run from step 2
on another night.

## 8. Verify checksums and counts

```bash
npm run verify:storage         # every Drive object: exists, size and checksum match the version
```

**Pass:** 0 missing, 0 mismatched. The version count in D1 (`migrate:verify` output,
`file_versions`) equals MongoDB's.

## 9. Verify ACLs

Covered by `migrate:verify` §3: sampled resources compared entry by entry, denials and expiries
included. For the cutover, also run the uniqueness validator against D1's source:

```bash
npm run acl:validate
```

**Pass:** 0 findings, plus a manual spot-check. Choose one restricted folder; confirm that in D1 a
user without access has no `resource_permissions` row granting it:

```bash
npx wrangler d1 execute biotech-drive-production $PROD --remote --command \
  "SELECT principal_type, principal_id, access_level, deny FROM resource_permissions WHERE resource_id='<folderId>'"
```

## 10. Verify version pointers

`migrate:verify` relationship checks: every `files.current_version_id` and
`files.approved_version_id` resolves, and exactly one `is_current` version per file.
**Pass:** no findings in `reports/cutover-verify.json` under the `version-*` checks.

## 11. Verify review / approval relationships

`migrate:verify` checks that every approval is bound to its review's exact version.
**Pass:** no `approval-*` / `review-*` findings. Spot-check the three most recent approvals in the
admin UI after step 17.

## 12. Verify search indexes

`migrate:verify` §4: every live file is in `files_fts` exactly once, and each sampled file is
found by its own name.
**Pass:** `ftsChecked` ≥ 100 with no FTS findings.

## 13. Switch the `DATA_SOURCE_*` flags

On the **Worker** (`wrangler.jsonc` → `env.production.vars`, or as secrets), set **all 24 flags to
`d1`**; the full list is in `DATA-SOURCE-FLAGS.md` §2. A production Worker refuses to boot with
any missing, so a partial switch cannot happen silently.

On **Node**, leave every flag unset. Node stays on MongoDB as the rollback target and is not
served to users after step 16.

## 14. Switch sessions and auth

* `DATA_SOURCE_SESSIONS=d1` is part of step 13. **Everyone is logged out at this point.** This is
  expected, and it is why the step sits inside the window.
* Sign-in is Cloudflare Access (`CF_ACCESS_*` secrets from 0.5). Password sign-in does not exist
  on the Worker.

## 15. Enable production Google Drive storage

Already enforced by `wrangler.jsonc` vars: `GOOGLE_DRIVE_STORAGE_ENABLED=true`,
`DEFAULT_STORAGE_PROVIDER=google_drive`, `UPLOAD_STAGING=google_drive`.
**Pass:** the values in `wrangler.jsonc` for `production` are unchanged from the reviewed
commit.

## 16. Deploy the Worker

```bash
npm run cf:build
npx opennextjs-cloudflare deploy -- --env production
```

Then route the production hostname to the Worker (DNS / Custom Domain), behind the Access
application.

**Pass:** the deploy succeeds; Workers Logs shows `Worker configuration accepted` with
`access: true` and the expected `malwareScanMode`, and **no** `fatal` line.

## 17. Smoke tests

Through Access, as a normal employee **and** as an administrator:

| Check | Pass |
|---|---|
| `GET /api/health/ready` | 200, `database: d1`, Drive `connected` |
| Sign in via Access | lands on /home; `/api/auth/session` shows the right user and roles |
| My Drive, open a migrated folder | contents match MongoDB for three spot-checked folders |
| Download and preview a migrated file | bytes open; the checksum of one file compared by hand |
| Upload a new file to a test folder | appears; malware scan logged (if enabled) |
| Upload version 2, request review, approve as a second user | approval shows on the reviewed version |
| Search for a migrated file by tag and by sample id | found |
| Starred, Recent, Shared with me | populated |
| Inventory: open an item, view stock history | matches MongoDB |
| Notifications | new ones from the test review arrive (queue consumer working) |
| Audit log (admin) | today's test actions present |
| Trash and restore the test file | works |
| Workers Logs | no `error` / `fatal` from `worker-entry`; queue messages `ack`ed |

**Stop** and roll back on any failure that affects data correctness, access control or
authentication. Cosmetic issues are logged and fixed forward.

## 18. End the write freeze

Traffic is now on the Worker. Node stays running, in `maintenance` mode, unreachable by users.
It is the rollback target (`ROLLBACK-RUNBOOK.md`). Announce the end of the window.

**Record `CUTOVER_AT`** (UTC). The rollback window starts now.

## 19. Monitor

| When | What |
|---|---|
| First 2 h, continuously | Workers Logs: `level:error`/`fatal`; 5xx rate; queue backlog; `SERVICE_MISCONFIGURED` responses (must be 0) |
| Every 15 min, first day | Dead-letter queues are empty: `npx wrangler queues consumer …` / dashboard |
| Daily, first week | Admin → System: Drive connection, sync status (cursor advancing every 15 min), malware check, storage |
| Daily, first week | D1 size and row counts growing plausibly; `migrate:verify` is *not* re-run (MongoDB is now stale by design) |
| Day 7 | Decide to close the rollback window (`ROLLBACK-RUNBOOK.md` §4); then decommission Node MongoDB writes, keeping a final snapshot for 90 days |

A message in a DLQ: read it, fix the cause, and replay it by re-sending its body to the main
queue. Consumers are idempotent (`23-worker-entrypoint-and-queues.md`).
