# Phase 9 — the MongoDB → D1 metadata migration

**Status: code complete and tested locally.** It has been dry-run against the development
MongoDB (292 records, 0 failed, 0 skipped). It has **not** been run against a production snapshot,
because no snapshot is available to this repository. That run is a rehearsal step in
`CUTOVER-RUNBOOK.md`, not a code gap.

This closes item §6.4 of the previous readiness report ("no Mongo → D1 metadata migration
tooling"). Byte migration (Phase 10, `services/storage-migration/`) is separate and already existed.

---

## 1. What was built

| Path | What it is |
|---|---|
| `src/server/migration/d1/types.ts` | The step contract, the gateway contract, the report shapes |
| `src/server/migration/d1/registry.ts` | The 33 steps in dependency order, plus the tables deliberately **not** migrated, each with its reason |
| `src/server/migration/d1/steps/*.ts` | One file per domain: identity, access, research, drive, collaboration, activity, inventory, operations |
| `src/server/migration/d1/runner.ts` | Page → transform → one `batch()` → checkpoint, repeat |
| `src/server/migration/d1/gateway.ts` | `BindingGateway` (Miniflare / Worker), `WranglerGateway` (operator laptop → local or remote D1), `DryRunGateway`, `ReadOnlyGateway`, `OfflineGateway` |
| `src/server/migration/d1/sql.ts`, `convert.ts`, `step-helpers.ts` | Statement builders (parameterised, upserts), Mongo → SQLite value conversion, the shared Mongo read shape |
| `src/server/migration/d1/validate-source.ts` | Pre-flight: finds source data a D1 constraint would reject |
| `src/server/migration/d1/verify.ts` | Post-load: counts, relationship invariants, ACL equivalence, search |
| `scripts/validate-mongo-source.ts` | `npm run migrate:validate` |
| `scripts/migrate-to-d1.ts` | `npm run migrate:d1` |
| `scripts/verify-d1-migration.ts` | `npm run migrate:verify` |
| `tests/d1/mongo-to-d1-migration.test.ts` | 18 tests: real `mongod` + real workerd SQLite |
| `tests/unit/migration-gateway.test.ts` | 17 tests: the read/write guarantees of each gateway |

## 2. The properties that matter, and where each is proven

| Property | How it holds | Proof |
|---|---|---|
| **Ids are preserved** | Every `_id` becomes the same 24-hex string in the TEXT primary key. There is no mapping table. | "copies every domain, preserving the MongoDB ids" |
| **A dry run writes nothing** | `--write` is required to write. Without it the gateway is a `DryRunGateway`: `run()` renders and counts the statements but never forwards them, and `query()` refuses anything that is not a `SELECT`/`WITH`/`EXPLAIN`. | "writes nothing at all in a dry run" (checks `d1_migration_runs` too); unit tests on `assertReadOnly` |
| **Verification is read-only** | `migrate:verify` wraps its gateway in `ReadOnlyGateway`, which throws on any `run()` | unit test "refuses every write" |
| **Re-running converges** | Every statement is an `ON CONFLICT … DO UPDATE` upsert or, for append-only tables, `DO NOTHING`. Array children are deleted and re-inserted per parent. | "changes nothing when it is run a second time": 34 table counts identical |
| **Resume after a crash** | A checkpoint per step per run in `d1_migration_runs`, advanced only after the page's batch returns | "resumes an interrupted run…" and "resumes a failed step from its last committed page…" |
| **One bad record does not lose a batch** | Transform errors go to `d1_migration_failures` with the payload. Dangling references become a *skip with a reason* before the batch, not an FK abort inside it. | "records a record it cannot migrate…" |
| **ACLs are resolved, not copied** | Duplicate principals collapse to the denial; expired grants are dropped | "resolves a duplicated ACL principal to the denial…" |
| **Version pointers and approvals survive** | Approval stays on the reviewed version, not the current one | "keeps the approval on the version that was reviewed" |
| **Search works after the load** | FTS rows are rebuilt with keywords, not left to the insert trigger (which writes empty keywords) | "makes migrated files findable by tag, sample id and description" |
| **Hidden fields come across** | `passwordHash`, MFA secrets and token hashes are `select: false` and are asked for explicitly | "keeps the password hash the schema hides" |
| **The final delta pass is correct** | See §3.1 | "applies a delta pass to a record whose parents did not change" |

## 3. Defects found in the review, and fixed

The tooling was written before this review. Three of the defects were real and one was a hazard.
None of them could have shown up in the original 16 tests, because none of those tests ran a delta
pass or a failing batch.

### 3.1 The final delta pass would have dropped or corrupted changed records

Reference checks are driven by `StepContext.known`: the set of ids each earlier step wrote in
*this run*. A delta pass (`--since`) reads only documents changed since the bulk load. So:

* The organizations step in a delta pass reads nothing, which leaves `known.organizations`
  empty.
* Every changed file then fails its organization check and is **skipped**. The edit made during
  the freeze window never reaches D1, and the report shows it as a skip rather than a failure.
* On nullable references (activity actor, `created_by` on roles, and others) the check does not
  skip. It writes **NULL over the correct value** that the bulk load had stored.

Resume had the same problem in a milder form. It re-read ids from the *source*, which includes
records the bulk load had skipped as orphans. A later step referencing one of those would then
fail on a foreign key inside a batch.

**Fix:** on resume, on a skipped step and on every delta pass, `known` is seeded from the
**target** (`SELECT id FROM <table>`, paged by id). The question every reference check asks is
"will this foreign key resolve in D1?", and only the target can answer it.

### 3.2 A failed step discarded its progress and double-counted on resume

On a batch failure the checkpoint was written with `last_id = NULL`, and with read/written counts
that included the page the database had just refused. Resume therefore restarted the step from the
beginning. Idempotence made that safe, but it was slow, and the counts were inflated by the
refused page. Now the checkpoint records the last *committed* cursor and counts.

### 3.3 A failed step did not stop the run

Later steps kept running. A step depending on the failed one would complete with the missing
parents recorded as orphan skips, and would then be marked `completed`. The next resume would
therefore skip it, and the gap would never be filled. **The run now stops at the first failed
step.**

### 3.4 Hazards closed

* An unparseable `--since` became `Invalid Date`, which matches nothing. The result would have
  been a delta pass reporting success after copying zero changes. It is now refused.
* `--env production --write` now also requires `--confirm production`.
* The usage text said `--env development --local` loads the local database. It does not: without
  `--write` every run is a dry run. The text is corrected.
* `recordTargetCount()` was unused and was the only write path near the verifier. It has been
  removed.
* `migration-reports/` holds source ids and failure payloads. It is now git-ignored.

## 4. Operating it

```bash
npm run migrate:validate                                   # read-only on Mongo; exit 0 = no blockers
npm run migrate:d1 -- --offline                            # dry run with no D1 at all
npm run migrate:d1 -- --env staging --remote               # dry run, reading the real target
npm run migrate:d1 -- --env staging --remote --write       # rehearsal load
npm run migrate:d1 -- --env production --remote --write --confirm production --run-id cutover-1
npm run migrate:d1 -- --env production --remote --write --confirm production --resume cutover-1
npm run migrate:d1 -- --env production --remote --write --confirm production --since <freeze-start ISO>
npm run migrate:verify -- --env production --remote --report reports/verify.json
```

* Every run writes a JSON report (`--report`, default `migration-reports/<runId>.json`) and
  exits non-zero if any record failed.
* Source validation blockers stop a `--write` run (exit 2) unless `--skip-validation` is given.
* `WranglerGateway` keeps each applied `.sql` batch file in `%TMP%/biotech-drive-migration/<runId>/`.
  These are the exact statements applied, kept for any incident review.

### 4.1 What is deliberately not migrated

The list lives in `INTENTIONALLY_NOT_MIGRATED` in `registry.ts`, and `verify.ts` does not report
these tables as missing:

* **Upload sessions:** the write freeze means none are in flight.
* **Password-reset tokens:** single-use; users request a new link.
* **Import / storage-migration / sync-job queues:** Node-only tooling state.
* **The permission catalogue:** seeded by migration 0001.
* **The migration's own tables.**

### 4.2 Known limitations

* **A delta pass cannot see hard deletes.** A document purged from MongoDB after the bulk load
  stays in D1. `migrate:verify` reports it as a count mismatch (target > source). The runbook
  therefore stops the purge jobs from the bulk load until cutover. The alternative is a fresh
  full load inside the freeze, which is safe because a load is idempotent.
* **Remote `--file` execution is not one transaction per file.** Through `wrangler d1 execute
  --remote --file` a batch is applied as an import rather than as a `batch()`. Idempotence plus
  the checkpoint still make a crash recoverable: re-run with `--resume`. A partially applied page
  is simply re-applied.
* **Collections with no timestamp** (`recent_items`) are re-read in full on every delta pass.
  They are small.

## 5. Verification

| Gate | Result |
|---|---|
| `tests/d1/mongo-to-d1-migration.test.ts` | **18 passed** (the original 16 plus 2 new: delta pass, failed-step resume) |
| `tests/unit/migration-gateway.test.ts` | **17 passed** (new) |
| `npm run migrate:validate` (dev Mongo) | PASS, no issues |
| `npm run migrate:d1 -- --offline` (dev Mongo) | 33 steps, 292 read / 292 would-write / 0 skipped / 0 failed, 715 statements rendered |
| `npm run migrate:d1 -- --env development` (dry run via local wrangler D1) | same totals; local D1 unchanged |
| `npm run typecheck` / `npm run lint` | clean |

**Test isolation:** the suite uses `mongodb-memory-server`, a throwaway replica set whose URI
overwrites `MONGODB_URI` in `startTestDb`. D1 is an in-process Miniflare instance. Neither can
reach the development or production databases.

## 6. Rollback

This phase adds tooling only. Nothing reads the new code at request time, and no `DATA_SOURCE_*`
flag changed. Reverting the commit removes it. A load already written into a D1 database is
removed by re-creating that database (`wrangler d1 delete` / `create`, then `db:migrate:*`). No
data leaves MongoDB, which stays authoritative until the cutover flips the flags.
