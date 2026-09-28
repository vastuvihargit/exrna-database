# Production-shaped rehearsal: exact commands

A rehearsal runs `CUTOVER-RUNBOOK.md` end to end against **staging**, loaded from a **production
snapshot**, and then runs `ROLLBACK-RUNBOOK.md`. Nothing here touches production except §1, which
only *reads* it.

Prerequisites: `EXTERNAL-SETUP.md` §1–§2 done for staging (D1, queues, Access, Shared Drive,
service account, secrets), and a staging MongoDB (a separate `mongod` replica set, never the
production one).

Conventions:

```bash
export STAGE="--env staging"
export STAGING_MONGODB_URI="mongodb://<staging-host>:27017/biotech_drive?replicaSet=rs0"
mkdir -p reports
```

Every command writes a report under `reports/`; attach them all to the rehearsal log together with
the wall-clock time of each step. Those timings size the production maintenance window.

---

## 1. MongoDB backup / snapshot

From production, read-only:

```bash
mongodump --uri "$PRODUCTION_MONGODB_URI_READONLY" --gzip --archive=prod-snapshot-$(date -u +%Y%m%dT%H%MZ).gz
```

Into the staging MongoDB (destroys staging's MongoDB contents — that is the intent):

```bash
mongorestore --uri "$STAGING_MONGODB_URI" --gzip --archive=prod-snapshot-<stamp>.gz --drop
```

The Node deployment's own backup job and restore drill (`docs/operations/`) are the production
backup; this snapshot is only rehearsal input. Treat it as production data: encrypted disk,
deleted after the rehearsal.

## 2. Validate the source

```bash
MONGODB_URI="$STAGING_MONGODB_URI" npm run migrate:validate
```

Pass: `PASS — no blockers`.

## 3. D1 migrations (schema)

```bash
npm run db:migrate:staging
npx wrangler d1 migrations list biotech-drive-staging $STAGE --remote     # 0000–0005 applied
```

To start a rehearsal again from an empty database, delete and recreate the staging D1
(`npx wrangler d1 delete biotech-drive-staging` → `create` → paste the new id → migrate). Never do
that to production.

## 4. Migration dry run

```bash
MONGODB_URI="$STAGING_MONGODB_URI" npm run migrate:d1 -- --env staging --remote \
  --run-id rehearsal-dry --report reports/rehearsal-dry.json
```

No D1 at all (e.g. on a laptop, to check transforms only): add `--offline`.

## 5. Migration execution

```bash
BULK_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MONGODB_URI="$STAGING_MONGODB_URI" npm run migrate:d1 -- --env staging --remote --write \
  --run-id rehearsal-bulk --report reports/rehearsal-bulk.json
```

## 6. Migration resume

Deliberately interrupt §5 once (Ctrl-C mid-run) and resume it — the rehearsal must prove this
works, because on the night it is the recovery path:

```bash
MONGODB_URI="$STAGING_MONGODB_URI" npm run migrate:d1 -- --env staging --remote --write \
  --resume rehearsal-bulk --report reports/rehearsal-bulk-resumed.json
```

Pass: `"ok": true`, `totals.failed = 0`, and the counts equal an uninterrupted run's.

## 7. Integrity validation

```bash
MONGODB_URI="$STAGING_MONGODB_URI" npm run migrate:verify -- --env staging --remote \
  --acl-sample 1000 --fts-sample 100 --report reports/rehearsal-verify.json
MONGODB_URI="$STAGING_MONGODB_URI" npm run acl:validate
```

## 8. Drive migration

The storage-migration tool runs on **Node** (it reads the local object store). Point a staging
Node instance at the staging MongoDB, the staging Shared Drive and a copy of the production object
store, then as an administrator:

```http
POST /api/admin/storage-migration            { "name": "rehearsal", "mode": "dry_run", "selection": {} }
POST /api/admin/storage-migration/{id}/plan
POST /api/admin/storage-migration            { "name": "rehearsal-run", "mode": "migrate", "selection": {} }
POST /api/admin/storage-migration/{id}/run
POST /api/admin/storage-migration/{id}/verify
```

```bash
MONGODB_URI="$STAGING_MONGODB_URI" npm run drive:drain
MONGODB_URI="$STAGING_MONGODB_URI" npm run verify:storage
```

Pass: dry run finally reports `selected: 0`; `verify:storage` 0 missing, 0 mismatched.
(The admin UI's *Storage migration* page drives the same API on Node; on the Worker the API
answers `501 NODE_ONLY_OPERATION` and the page says so.)

## 9. Final delta

Make a few changes in the staging Node UI (a folder, an upload, an approval, a stock movement)
**after** `BULK_START`, then enter the freeze (`MAINTENANCE_MODE=maintenance` on staging Node) and:

```bash
MONGODB_URI="$STAGING_MONGODB_URI" npm run migrate:d1 -- --env staging --remote --write \
  --since "$BULK_START" --run-id rehearsal-delta --report reports/rehearsal-delta.json
MONGODB_URI="$STAGING_MONGODB_URI" npm run migrate:verify -- --env staging --remote \
  --require-drive-storage --acl-sample 1000 --fts-sample 100 --report reports/rehearsal-verify-final.json
```

Pass: the changes made after `BULK_START` are present in D1 (check each by id); verification PASS
with no `versions-not-in-drive`.

## 10. Switch flags and deploy staging

Set the 22 `DATA_SOURCE_*=d1` vars in `env.staging.vars` (`DATA-SOURCE-FLAGS.md` §2), then either
run the `Deploy Cloudflare Worker (staging)` workflow, or locally:

```bash
npm run cf:build
npx opennextjs-cloudflare deploy --env staging
npx wrangler tail --env staging --format pretty      # watch the startup line in another terminal
```

Pass: `Worker configuration accepted`, `access: true`, no `fatal`.

## 11. Smoke testing

Run the table in `CUTOVER-RUNBOOK.md` step 18 through Access on the staging hostname. In
addition, machine checks:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://<staging-host>/api/health          # 302 to Access (not signed in)
curl -sS -H "cf-access-token: <token from a signed-in browser>" https://<staging-host>/api/health/ready
```

Then let the scheduled work run and confirm it is consumed. A deployed cron trigger cannot be
fired from the CLI, so wait for the next `*/15` (Drive sync) and `:07` (maintenance) triggers:

```bash
npx wrangler tail --env staging --search "Scheduled work enqueued"   # the cron handler: lists the jobs
npx wrangler tail --env staging --search "Queue message processed"   # each consumer ack, with its job
npx wrangler queues list                                             # backlog drains to 0; DLQs stay empty
```

The automated local equivalent of these smoke tests is `npm run test:e2e` (the whole working-day
flow against local D1), plus the Worker preview checks in `26-worker-preview.md`.

## 12. Rollback

Run `ROLLBACK-RUNBOOK.md` §2 against staging in full, including the D1 export:

```bash
npx wrangler d1 export biotech-drive-staging $STAGE --remote --output reports/rehearsal-rollback.sql
```

and §3's reconciliation query against the changes made during §11. Pass: staging Node serves
again from MongoDB, the §2 step-10 validation table passes, and the reconciliation list contains
exactly the smoke-test writes.

---

## Rehearsal sign-off

| Item | Result | Time taken |
|---|---|---|
| Snapshot restored | | |
| Validate | | |
| Dry run | | |
| Bulk load (with one resume) | | |
| Verify | | |
| Drive migration + verify:storage | | |
| Final delta + verify | | |
| Staging deploy + smoke tests | | |
| Rollback + validation | | |

The production window = the sum of *bulk load* (if not done ahead) + *final delta* + *verify* +
*smoke tests*, plus 50 %.
