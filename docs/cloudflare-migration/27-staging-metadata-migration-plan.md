# Staging MongoDB → D1 metadata migration: audit and plan

> **Superseded (2026-09-30, later the same day).** The owner decided there is no MongoDB data to
> preserve: staging is a **fresh D1 deployment** and the Mongo → D1 migration below is skipped
> entirely. Instead, `npm run bootstrap:d1 -- --env staging --remote --admin-email cmc@exrna.com
> --write` (`scripts/bootstrap-d1.ts`) created the organization (`exrna`), the 12 system roles
> and one active Super Admin with a single company-scope `super_admin` grant; a second run changed
> nothing. All 22 `DATA_SOURCE_*` flags are `d1` in `env.staging.vars`. The Time Travel bookmark
> taken before the bootstrap is `00000006-00000000-000050f6-b6214279e8bcbf5c260add32f3cab6b5`.
> `AUTH_SECRET` / `SESSION_SECRET` are now real Worker secrets (§1.5.3 is resolved). The rest of
> this document is kept as the record of the migration audit.

**Status (2026-09-30, original): planned, validated and dry-run only. Nothing has been written to
staging D1, no `DATA_SOURCE_*` flag has changed, nothing has been deployed.**

This adapts `REHEARSAL.md` §1–§7 to the staging set-up as it actually is: Google Workspace OAuth
instead of Cloudflare Access (`AUTH_PROVIDER=google_oauth`), and a staging D1 that holds the
schema only. The tooling itself is described in `21-phase-9-mongo-to-d1-migration.md`.

---

## 1. Audit findings

### 1.1 Tooling

| Check | Result |
|---|---|
| `tests/d1/mongo-to-d1-migration.test.ts` (real `mongod` + workerd SQLite) | **18/18 pass**: ids preserved, dry run writes nothing, re-run converges, resume, ACL resolution, approval-on-reviewed-version, FTS rebuild, delta pass |
| `tests/unit/migration-gateway.test.ts`, `data-source-matrix.test.ts` | **34/34 pass** |
| Coverage | 33 steps: organizations, departments, users, app settings, roles and user roles, projects, experiments, folders and hierarchy, files, file versions, folder and file ACLs, comments, reviews, notifications, audit logs, sessions, login history, activities, stars, recent items, saved searches, inventory items, stock transactions, Drive sync state, alert states. The permission catalogue is seeded by D1 migration 0001, not copied. Upload sessions and reset tokens are deliberately not migrated (`registry.ts`, `INTENTIONALLY_NOT_MIGRATED`). |
| Safety | Dry run by default (`--write` required); upserts, so a re-run converges; checkpoint per page in `d1_migration_runs`; failures recorded per record in `d1_migration_failures`; `migrate:verify` is wrapped in a read-only gateway; production writes need `--confirm production` |

### 1.2 Staging target (`biotech-drive-staging`, remote, read-only `SELECT count(*)`)

55 tables. Non-empty: `d1_migrations` = 6 (schema applied), `permissions` = 28 (seed). **Every
data table is empty**: there are no D1 users, organizations, roles, sessions or ACLs on staging to
preserve or collide with.

### 1.3 The only reachable source is the local development MongoDB

`.env` points at `mongodb://127.0.0.1:27017/biotech_drive_dev`. No staging or production MongoDB
is configured in this repository.

| | dev MongoDB |
|---|---|
| Records the migration reads | 295 (1 organization, 4 departments, 6 users, 10 roles, 6 user roles, 29 folders, 4 files, 5 versions, 104 audit logs, 6 login-history rows, 26 activities, 1 star, 12 recent items, 4 alert states) |
| Projects, experiments, reviews, comments, notifications, inventory, sessions | 0 |
| Users | all `@exrna.com`: 3 active, 1 active super-admin, 2 deactivated super-admins |
| Organization `emailDomains` | `["exrna.com"]`, consistent with `GOOGLE_WORKSPACE_DOMAIN` |
| File storage | all 4 files `local` (provider `local` or unset); **none in Google Drive** |

### 1.4 Validation and dry run (done)

| Step | Command | Result |
|---|---|---|
| Source validation (read-only on Mongo) | `npm run migrate:validate` | **PASS: no blockers** |
| Dry run against real staging D1 | `npm run migrate:d1 -- --env staging --remote --run-id staging-dryrun-1` | 33 steps, **295 read / 295 would-write / 0 skipped / 0 failed**, 718 statements rendered |
| Target unchanged afterwards | table counts re-read | still only `d1_migrations` = 6, `permissions` = 28; no `d1_migration_runs` rows |

### 1.5 Blockers and risks

1. **Which MongoDB is the real source?** The dev database is small (6 users, 4 files, no
   projects). If production MongoDB (the Docker/SSH Node deployment, `deploy.yml`) holds more,
   staging must be loaded from a **production snapshot restored into an isolated staging
   `mongod`**, never from production directly and never from the developer database by accident.
   This is a decision for the owner, and it changes every count above.
2. **File bytes are not in Google Drive.** A Worker has no filesystem, so on staging the 4
   migrated files would be listed but not downloadable. `migrate:verify --require-drive-storage`
   fails until the Node storage migration (`REHEARSAL.md` §8) has moved them. The metadata load
   does not depend on it; switching the flags for file access does.
3. **`AUTH_SECRET` / `SESSION_SECRET` are still dashboard plain-text variables** on
   `exrna-database-staging` (latest version `6de5fe12`, 06:17 UTC); `npm run
   cf:check-secrets:staging` fails. This blocks the deploy, not the data load.
4. **The C: drive was full** (60 KB free, 244 GB disk) during this audit; the migration test's
   `mongod` crashed with `fassert()` until 757 MB was freed. mongod on a full disk risks the
   source database. Free at least 20 GB before any `--write` run: the gateway writes every batch
   as a `.sql` file under `%TMP%/biotech-drive-migration/<runId>/`.
5. **Sessions**: none are migrated (the source has 0). Users sign in fresh through Google OAuth.
   Only active `@exrna.com` users with an existing row can sign in; there is 1 active super-admin.

---

## 2. Plan: gated, one step at a time

Each gate must pass before the next begins. Steps 1–7 touch only staging D1 (and read MongoDB);
MongoDB is never written.

| # | Step | Command | Pass |
|---|---|---|---|
| 0 | Prerequisites | disk ≥ 20 GB free; source decided (§1.5.1) | owner sign-off |
| 1 | Snapshot (only if the source is production) | `mongodump --uri "$PRODUCTION_MONGODB_URI_READONLY" --gzip --archive=…` then `mongorestore --uri "$STAGING_MONGODB_URI" --drop` into an **isolated** `mongod` | restore completes; counts recorded |
| 2 | Validate source | `MONGODB_URI=… npm run migrate:validate` | `PASS — no blockers` |
| 3 | Dry run against staging | `MONGODB_URI=… npm run migrate:d1 -- --env staging --remote --run-id staging-dry --report reports/staging-dry.json` | 0 failed, 0 unexplained skips |
| 4 | Restore point | `npx wrangler d1 time-travel info biotech-drive-staging --env staging` (record the bookmark) and `npx wrangler d1 export biotech-drive-staging --env staging --remote --output reports/staging-pre-load.sql` | bookmark and export saved |
| 5 | Load | `MONGODB_URI=… npm run migrate:d1 -- --env staging --remote --write --run-id staging-bulk-1 --report reports/staging-bulk-1.json` | `"ok": true`, `failed = 0`, written = dry-run count |
| 6 | Idempotency and resume | re-run step 5 with `--resume staging-bulk-1`, then once more as a fresh run | table counts identical; nothing duplicated |
| 7 | Verify (read-only) | `MONGODB_URI=… npm run migrate:verify -- --env staging --remote --acl-sample 1000 --fts-sample 100 --report reports/staging-verify.json` and `npm run acl:validate` | counts, relationship invariants, ACL equivalence and search: PASS |
| 8 | Spot checks | by id: each active user's roles and permissions, one folder's and one file's effective ACL, the super-admin flag, an approval on its reviewed version | match MongoDB |
| 9 | Files into Drive (separate decision) | `REHEARSAL.md` §8 on a Node instance, then `migrate:verify … --require-drive-storage` | no `versions-not-in-drive` |
| 10 | **Stop.** Flags and deploy | only after 2–8 pass (and 9, if file access is in scope), with the owner's approval: 22 `DATA_SOURCE_*=d1` in `env.staging.vars`, `npm run cf:check-secrets:staging`, `wrangler deploy --dry-run --env staging`, then `npm run cf:deploy:staging` | separate request |

After step 10 the smoke test is Google OAuth sign-in (not Access) as an active `@exrna.com` user,
then the checks in `REHEARSAL.md` §11.

## 3. Rollback

* **Before step 10:** nothing reads staging D1, and MongoDB was only read, so there is nothing to
  roll back in the application. To discard a load: `npx wrangler d1 time-travel restore
  biotech-drive-staging --env staging --bookmark <step-4 bookmark>`, or delete and recreate the
  staging database and re-run `npm run db:migrate:staging` (then paste the new `database_id`).
* **After step 10:** remove the `DATA_SOURCE_*` vars and redeploy. That is data-safe only while
  staging has taken no D1-only writes (`DATA-SOURCE-FLAGS.md` §6, `ROLLBACK-RUNBOOK.md`).
