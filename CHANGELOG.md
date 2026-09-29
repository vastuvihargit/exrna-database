# Changelog

All notable changes to the Biotech Research Drive.

## [Cloudflare migration — verification pass] — 2026-09-29

Everything below was found by running the full gates — the browser suite to the end, the full
D1 suite, and a fresh Worker preview — rather than by review. Results:
`docs/cloudflare-migration/FINAL-READINESS.md`.

### Security
- **Confidential projects were visible below clearance**, on both engines. The project list (which
  also gates `GET /api/projects/:id`) and the project drive let every role-scope route in
  regardless of classification. Role scope now requires the project's classification to be within
  the actor's clearance, as files and folders already did; members and the lead still see it.
- **The per-IP sign-in limit was keyed on a client-written header.** The first
  `X-Forwarded-For` entry is whatever the client sent (Cloudflare and nginx both append), so the
  limit could be reset per attempt. Now `CF-Connecting-IP`, then `X-Real-IP`.

### Fixed
- **Overlapping D1 expiry sweeps wrote the same stock off twice** (a phantom ledger row). The
  ledger insert is now guarded by the rows as they stand inside the atomic batch.
- **A revoked session locked the person out of the sign-in page** (`ERR_TOO_MANY_REDIRECTS` after
  any role change). A dead cookie is now cleared through `/api/auth/session-expired`.
- **Password sign-in on a Worker** answered 500 for an unknown address and "incorrect password"
  for a known one; it is now refused deliberately, like password reset.
- **A record still on local disk downloaded from a Worker as a truncated file**; the local provider
  is no longer registered there, so it fails before any byte is sent.
- **The employee table re-rendered for ever while loading**, hanging the *Add employee* pickers.
- **Cloudflare Workers Builds failed on its default commands** (`npm run build` +
  `npx wrangler deploy`): a plain `next build` left no Worker and let the argon2 native addon
  into the bundle. `npm run build` now runs `cf:build` when `WORKERS_CI=1`; elsewhere it is
  unchanged. The Worker is renamed `exrna-database` to match the Cloudflare project.

### Tests
- Browser suite green: **34/34** on the D1 backend (was 18/32). Spec defects fixed along the way
  are listed in `25-browser-e2e.md` §5; global setup now survives a path containing a space.
- The route-protection test recognises `withNodeOnlyRoute` and pins that it authenticates.
- Worker preview verification written up: `26-worker-preview.md`.

## [Cloudflare migration — production readiness] — 2026-09-28

The last locally-fixable gaps between "every module has a D1 repository" and "ready for a
production-shaped rehearsal". Status and exact test results: `docs/cloudflare-migration/FINAL-READINESS.md`.

### Added
- **Browser E2E suite** (Playwright, `npm run test:e2e`): a scientist's working day with a second
  user, inventory, and administration, through the real UI against a seeded local D1 that the
  real migration tool loads and verifies on every run (`25-browser-e2e.md`).
- **Scheduled maintenance on the Worker.** A second cron trigger (`7 * * * *`) enqueues expired
  upload cleanup and the Drive approval check hourly, and the trash purge and **inventory expiry
  sweep** daily, through the sync queue. The Node scheduler gains `inventory:expire`. Both call
  the same service functions; every job is idempotent.
- **Durable Object rate limiting on the Worker** (`RATE_LIMITER`). The in-process counter counted
  per isolate there — a limit that mostly did not exist. Node keeps the in-process store.
- **Node-only admin tools answer a Worker with `501 NODE_ONLY_OPERATION`** (Drive import, storage
  migration, retained local copies) before any Mongo or filesystem code runs; their tabs are
  hidden on the Worker.
- CI: Drizzle schema-drift gate, Worker build and dry-run bundle, E2E job; `.dev.vars` added to
  the committed-secrets check. A staging-only Cloudflare deploy workflow; production stays a
  runbook step.

### Changed
- **Password reset** is refused, with a pointer to the identity provider's recovery, wherever the
  application does not own the password: behind Cloudflare Access and on any Worker.
- An HTTP malware scanner now **fails closed by default on every Worker and on staging**, not only
  in production. Failing open requires an explicit `MALWARE_SCAN_FAIL_CLOSED=false`.

### Fixed
- A Worker configured as documented (no `MONGODB_URI`, no local storage roots) passed its startup
  gate and then failed every request that read the shared environment schema. Local previews had
  hidden it because a developer `.dev.vars` carried both.
- `drizzle/migrations/meta` stopped at 0004: the next `db:generate` would have re-emitted 0004's
  and 0005's columns as a colliding `0005_*.sql`. The journal and a current snapshot now describe
  0005, and generation is a no-op.
- `DATA_SOURCE_COLLABORATION` and `DATA_SOURCE_JOBS` were production switches no code read. Removed;
  a test now fails if a declared flag has no reader.
- `opennextjs-cloudflare deploy -- --env X` passed `--env` to wrangler only, so OpenNext's own
  cache population targeted the top-level environment. The docs and workflow now use
  `deploy --env X`.
- The *New department* form could not be submitted with the optional quota left empty.
- `D1_LOCAL_PROXY_PERSIST` (E2E's local D1) is refused unless `NODE_ENV` is development or test.

## [Drive Storage — Phase 11] — 2026-08-02 — Giving up the safety net, on purpose

Every migrated version has kept its local bytes since Phase 5, and that retention has been
load-bearing in two ways: rollback is a field flip *because* the bytes never left, and Phase 4
serves the retained copy when a Drive object goes missing. Removing them ends both guarantees.

So this phase is not tidying up. It is the deliberate surrender of the migration's safety net,
and everything about it is shaped by making that a decision rather than a default.

### Archive and delete are two actions, not one with a flag

"Reclaim the disk" and "give up the ability to undo" are different wishes. A single delete
action conflates them.

**Archive** moves the bytes from `originals` into `archives` and records where they went.
Rollback still works — it restores from the archive first. All the disk comes back. This is the
one to reach for.

**Delete** removes them. It additionally requires `DELETE_LOCAL_AFTER_MIGRATION=true`, an
explicit request, and — the part that matters — a **live check that the file really is in Drive
at that moment**. `migrationStatus: 'verified'` was set by a job weeks ago and nobody has
re-checked it since; if somebody has emptied the Shared Drive trash in the meantime, deleting
the only other copy on the strength of that stale flag is precisely the data-loss event the
whole retention design exists to prevent. A file failing that check is skipped, counted, and
the reason reported.

### `storageKey` is still not rewritten

Archiving does not touch `storageKey` or `storageArea` — they are immutable and stay that way,
because they record the address the version was *created* at, which is what its checksum and
its approval refer to. The archive location goes in a new `archivedStorageKey`: "the bytes are
still here, just moved aside", which is what makes an archived copy something rollback can
restore from.

### Added
- `local-copies.ts` — eligibility, summary, and the two actions. Five conditions, all required,
  none inferred from another.
- `GET`/`POST /api/admin/storage/local-copies`. **`dryRun` defaults to true** — the only
  endpoint here whose safe mode is the default. A mistyped request removes the last copy of
  somebody's data; a round trip costs nothing against that.
- Rollback now restores an archived copy back to the version's own address before flipping the
  record, and still refuses outright for a deleted one.
- **"Local copies kept after migration"** on the System page: how much disk they hold, how much
  is past its retention window. Always `ok` — those files are doing exactly what they were kept
  for, and flagging them would invite somebody to clear them for a green tick.

### Deliberately no cron script
`drive:drain`, `drive:sync` and `drive:check-approvals` are all scheduled because all three are
safe unattended. This is not. §18 says archival and deletion happen "only after explicit admin
approval", and a scheduled job is the precise opposite. The absence of automation is the
feature.

### The rest of the phase, checked rather than done
No file outside `src/server/storage/` imports `node:fs` — Phase 1's abstraction left nothing to
remove. No Drive environment variable is unused. `LocalStorageProvider` stays and is not
legacy: it backs every pre-migration file, every upload's quarantine and scan stage, every
retained copy and every rollback.

### Tests — 661 passing (up from 644)
17 new, and the one that matters most is a refusal: with deletion switched on and the retention
window passed, a file whose Drive object has vanished keeps its local copy and says why.

## [Drive Storage — Phase 10] — 2026-08-02 — The order to do it in

No code. Everything this phase needs was built in Phases 1–9; what it adds is the sequence, and
the points at which to stop.

That is not a gap. A migration tool that is safe only when driven in a particular order has an
undocumented dependency, and `docs/storage-migration/10-phase-10-production-migration.md` is
that dependency written down: the six controlled groups, the five steps repeated for each, when
to switch new uploads over, and what to do about each way it can go wrong.

Two things in it are worth repeating here.

**Do not migrate everything in one job** — not because the runner cannot, but because a job is
the unit of rollback. One job over the whole corpus means the only available undo is "undo
everything", and it will be wanted at the moment that is least acceptable.

**Rehearse the rollback on group 1.** Roll the internal test folder back deliberately, confirm
the files still open, then migrate it again. A rollback path that has never been executed is a
hypothesis, and group 5 is not when to test it.

**This is a plan, not a record.** No group has been migrated; there is no production deployment
and no real Shared Drive yet. The phase is complete in that the sequence and the stopping points
are decided and written down. It cannot be complete in the other sense until Phase 2's manual
checklist has been run against real Google infrastructure — **still the largest untested surface
in this project**.

## [Drive Storage — Phase 9] — 2026-08-02 — Finding out what happened while nobody was looking

Phases 5–8 assume this application is the only thing that touches the Shared Drive. It is not.
People open it in the Drive web UI, rename things, drag them about and empty the trash. This
is what notices.

### The policy, and the one decision worth arguing about

**Drive is authoritative for content. This application is authoritative for structure.**

Content changes, renames, trash and restore are adopted. Moves are not — and neither are
folder renames or folder trashing.

That refusal is deliberate and it is the interesting part. In this codebase a file's folder
chain *is* its permission chain and its quota owner. Applying a Drive move would mean somebody
drags a file in the Drive web UI — possibly somebody with no account here at all — and this
application silently changes who may read that research file, because the destination folder's
ACL now governs it. §13 makes the MongoDB permission model authoritative precisely so that
cannot happen, and §8 makes this application's hierarchy the one Drive mirrors rather than the
other way round.

So the divergence is recorded where an administrator sees it, and putting it right stays a
person's decision. The cost, stated plainly: the two hierarchies can drift, and reconciling is
manual. That is the right trade against permission laundering.

### An expired cursor is not an empty page

Drive expires start page tokens and answers a stale one with `404`. Reading that as "no
changes" is the worst failure available here — the poll succeeds, the summary says zero, the
System page stays green, and the two systems drift apart permanently and *invisibly*. Nothing
downstream would ever discover it.

A 404 forces a full reconcile instead: re-read every Drive-backed version and compare. A fresh
cursor is taken **before** the reconcile starts, so anything that changes during it lands in
the next incremental poll rather than in the gap between the two. Tested with both a content
change and a removal that happened while the cursor was dead.

### The ordering that makes replay safe

The cursor advances **after** a page has been applied. A crash in between replays that page,
so every application is idempotent — which is also what makes the round trip safe: this
application's own rename produces a Drive change that comes back through the feed, and
re-applying it must be a no-op rather than a second audit entry every poll, forever. A test
winds the cursor back by hand and asserts nothing moves.

### Added
- `drive-sync.service.ts`, `DriveSyncState` finally in use (Phase 3 created it and said
  nothing would read it until now), and `changes.list` / `changes/startPageToken` on the Drive
  client.
- `npm run drive:sync` and `POST /api/admin/storage/sync`. **The first run applies nothing** —
  it takes a cursor and stops. There is no attempt to catch up on what happened before
  synchronization was switched on; the feed does not reach back that far.
- An approved document edited in Drive goes back to review *within the same run*, not at the
  next nightly sweep. The feed has just said exactly which file it is.
- **"Shared Drive synchronization"** on the admin System page. The condition it exists for is
  the one that looks like success: when nobody is polling, every poll returns nothing and no
  page anywhere looks wrong. Only the age of the last successful run reveals it — three missed
  intervals, not one, because a check that cries wolf on jitter gets ignored when it matters.
- `DRIVE_SYNC_INTERVAL_MINUTES`. It schedules nothing; it is what the System page measures
  against. Setting it without scheduling the job produces a warning, which is correct.

### Not done, and deliberately
**Adoption of natively-created documents.** A Doc created directly in the Shared Drive is
counted as unmanaged and left alone. Phase 8 built everything such a document would need, and
the missing piece is small — but adopting an arbitrary Drive object means deciding its owner,
department, project, confidentiality and ACL from a filename and a parent folder. Those are
guesses with permission consequences. It needs a product decision (open question 4 in the
Phase 0 analysis, still unanswered), not a default invented here.

**Drive permission changes are not reflected.** Under §13 they change nothing here: MongoDB
decides access. Mirroring Drive's sharing into the application's ACL would invert the
authority the whole design rests on.

### Tests — 644 passing (up from 622)
22 new. The ones that matter are the refusals and the disasters: a Drive move leaves the file
where it was and files a conflict; a removed object never deletes a record; a replayed page
adds no second audit entry; a failed run leaves the cursor exactly where it was.

## [Drive Storage — Phase 8] — 2026-08-02 — An approval stops being a promise about a filename

Versioning already worked across providers — a file with v1 local and v2 in Drive has been an
ordinary state since Phase 3. What did not work is the thing this phase is about.

### The guarantee that quietly stopped holding

An approval in this system is pinned to a version, and a version's content-identity fields are
immutable. That was a *complete* guarantee for exactly as long as the bytes were on our own
disk under a key nothing rewrites.

A Google Doc can be rewritten by anyone who can open it, and **nothing in the version document
changes when it is** — same checksum, same size, same `isApproved: true`. The record would go
on saying "Priya approved this on the 3rd" over content Priya never saw.

So an approval now records the Drive *revision* it was granted against, and something asks
whether that is still the current one.

### The trap this had to avoid

The obvious implementation compares `headRevisionId` from `files.get`. Drive populates that
field **only for files with binary content**; for a Doc, Sheet or Slide it is simply absent.
That implementation would compare `undefined` to `undefined`, conclude "unchanged", and report
every edited Doc as still approved — passing a casual test against a PDF while failing against
the exact file type the requirement is about.

The binding reads `revisions/head` instead, which is populated for both. The fake Drive was
changed to model the asymmetry (native documents now have no `headRevisionId`, as in reality),
and the native test asserts that absence *before* asserting the edit is still detected. Anyone
who simplifies this back gets a failing test rather than a silent regression.

### Marked stale, never erased

| | |
|---|---|
| `isApproved` | cleared — it is what the badge and the approved-files list read |
| `approvedBy`, `approvedAt` | **kept** — who signed, and when, is still true |
| Review request and decisions | **untouched** — reviewers, comments, IPs, timestamps |
| File | back to `changes_requested`, `approvedVersionId` cleared |

"Nobody approved this" and "this was approved by Priya on the 3rd, and the document has since
changed" are different claims. Only the second is true, and it is the one recorded.

### The line that matters most

`unavailable` is a distinct outcome from `unchanged`. If a Drive outage were recorded as "no
change", one bad hour would silently certify the whole corpus as still-approved. Those rows
keep their approval, are counted, and are checked again next run. `missing` is separate too: a
document that vanished has not been *edited*, and sending it back to review would be a false
statement about what happened to it.

### Added
- `approval-integrity.service.ts` — bind, check, return-to-review. Local versions are treated
  as `unbound` and cost nothing, so enabling this part-way through a migration is free for
  every file that has not moved yet.
- `POST /api/admin/storage/approval-check` and `npm run drive:check-approvals` (`--all` to
  walk everything). Cursor-resumable and bounded: one Drive call per live approval, against a
  quota employees' uploads and downloads share.
- Approving content that changed *since it was sent for review* is refused
  (`CONTENT_CHANGED`). Rejecting it is still allowed — the reviewer has seen enough, and
  blocking that would leave the request stuck open.
- `GET /api/files/{id}/open` — the Google editor, as a 302 rather than a URL in a response
  body, gated on `file.download` and on `GOOGLE_DRIVE_NATIVE_EDITOR_ENABLED` (**off by
  default**: employees' own Google accounts are not necessarily members of the Shared Drive,
  and a button leading to a Google permission-denied page cannot be fixed from here).
- `auditService.recordSystem()` and the `file.approval_invalidated` action. The actor is
  `system:approval-integrity`, never a synthetic administrator — background work must not put
  a permission-bearing identity into the audit trail that nobody can be held to.
- **"Approved documents that changed"** on the admin System page. A warning while non-zero,
  never critical, and with no threshold below which it is acceptable.

### Deliberately not added
An activity-feed entry. That feed answers "who did what" and its actor is a required reference
to a real person. Nobody did this. Inventing a user would put a fictional colleague in the one
view people read to find out who touched their work.

### Backward compatibility
Every field defaults; no backfill. An approval that predates the binding has no revision to
compare against, and both obvious readings are wrong — a mismatch would send every historic
approval back to review over a change that never happened, a permanent match would leave it
unwatched forever. The first check **adopts** the current revision and reports `unchanged`;
from then on it is watched like any other. Tested, including that the next edit is caught.

### Tests — 622 passing (up from 597)
25 new. The ones that carry weight are the negatives: Drive returning 503 leaves the approval
intact and says so; a deleted Drive object is a storage conflict rather than a stale approval;
a locally-stored approval never causes a Drive call at all; a second check does not raise a
second audit entry.

## [Drive Storage — Phase 7] — 2026-08-01 — Mutations reach the Shared Drive

*Recorded after the fact — this phase shipped without a changelog entry. Written from the
code in `services/storage-migration/drive-mirror.ts` and its 17 tests in
`tests/integration/drive-mutations.test.ts`.*

Rename, move, trash and restore now apply to the Drive objects as well as the database, so
somebody browsing the Shared Drive does not see a tree that stopped matching reality.

**The ordering rule is Drive first, then MongoDB, and undo Drive if MongoDB fails.** The
alternative — commit locally and mirror afterwards — produces a record saying a file was
renamed while Drive still shows the old name, with nothing in the system aware the two
disagree. Drive-first means a Drive failure happens before anything local has changed: both
sides are still at the original state and the user gets a plain "that did not work", which is
the truth. The remaining window (Drive succeeded, MongoDB then failed) is compensated.

A folder operation is one Drive call because Drive cascades; a file operation touches one
object per migrated version, bounded at 50 so a single click can never become a thousand
sequential Drive calls inside one request. A partially-applied batch is rolled back rather
than left half-renamed.

Creating a folder is deliberately *not* mirrored — decision D7 keeps folder mirroring lazy, so
a Drive folder appears the first time content needs to land in it rather than filling the
Shared Drive's item budget with empty folders.

## [Drive Storage — Phase 6] — 2026-08-01 — New uploads go to Drive, but never wait for it

Setting `DEFAULT_STORAGE_PROVIDER=google_drive` now means new uploads end up in the Shared
Drive. **The upload tray is unmodified** — not one line of `upload-tray.tsx` changed, which
was the acceptance criterion.

### The decision that shaped this phase

Phase 0's decision D6 said finalize should return `status: 'saving'` above ~100 MB and
complete in the background, because finalize would otherwise block for the whole
server→Drive transfer. That reasoning was sound when it was written — but Phases 3–5 have
since made a better option available, and we took it.

**An upload never depends on Google being reachable.** The file is written locally,
verified, signature-checked, scanned and recorded *first*. At that moment it is a complete,
readable, downloadable file backed by the local provider — the exact state every
pre-migration file is in, which the whole of Phase 4 exists to serve. Handing it to Drive is
then a separate step that can fail, retry, or wait out an outage without anybody's upload
failing.

So there is no `saving` state, because there is no window in which the employee's file does
not exist. The trade D6 was managing — a long finalize — is handled by not doing the transfer
inside the request at all, rather than by adding a status to wait in.

| | D6 as written | What shipped |
|---|---|---|
| Drive is down | uploads fail | uploads succeed; a queue forms |
| Transfer fails | upload reported failed | file is fine, retried later |
| Large file | user waits in `saving` | file usable immediately |
| New states | tray gains `Saving` | none |

The cost, stated plainly: during a Drive outage, local disk holds pending files for longer.
That is visible on the admin System page, and it is the same disk those files occupy for
`LOCAL_COPY_RETENTION_DAYS` anyway.

### How it works

```
quarantine → size/checksum → signature → malware scan → move to originals (local)
   → commit MongoDB record                      ← the file exists and works from here on
   → small file & Drive healthy?  transfer inline
   → otherwise                    migrationStatus: 'queued'
   → return Complete
```

Bytes reach Drive from `originals`, **never from quarantine**. The signature check and the
malware scan both read the content back before it is trusted, and putting an unscanned file
at a real Drive id — visible in the Drive web UI, syncable to desktops, indexable — during
the scan window is exactly what decision D1 refuses. That decision is unchanged and now
load-bearing in a second place.

### It reuses Phase 5's transfer verbatim

`transferItem` was split into `transferVersion` (the work) and the item bookkeeping around
it, so an uploaded file reaches Drive through *the same code* a migrated one does: the same
checksum verification, the same four duplicate-prevention layers, the same recovery-row
ordering. An upload-specific transfer would have been a second place for all of that to be
subtly wrong.

The consequence is asserted directly: **a newly uploaded file is indistinguishable from a
migrated one** — same `localCopyState`, same retention date, same retained `storageKey`,
same `syncStatus`. So Phase 4's missing-object fallback and Phase 5's rollback both apply to
it. Without that, every guarantee built in Phases 3–5 would cover only half the corpus.

### Added
- `pending-transfers.ts` — the queue. `queueForDrive`, `listPending`, `countPending`,
  `drainPendingTransfers`. A failed drain leaves each file exactly as it was, so the worst
  outcome of a bad run is that nothing moved.
- `npm run drive:drain` for cron, and `POST /api/admin/storage-migration/drain` so an
  administrator can clear a backlog immediately after fixing a connection.
- A **"Files waiting for the Shared Drive"** check on the admin System page. Never critical:
  nothing is broken for anybody *using* the application — a backlog is broken for the
  administrator, and they are the one reading that page.
- `UPLOAD_DRIVE_SYNC_THRESHOLD_MB` (default 100). A latency control, not a correctness one.

### Tests — 580 passing (up from 570)
10 new, and the ones that matter are about Drive misbehaving: an upload succeeds with Drive
returning 503; a 403 harms nothing; a large file is queued without the employee waiting; a
drain run twice creates no second object; a deployment with Drive *connected* but new
uploads still local touches Drive not at all.

Phase 5's 22 tests pass unchanged after the `transferVersion` refactor, which is what makes
"same code path" a fact rather than a claim.

### Verified in the running server
With Drive off, the full upload → finalize → download round trip is byte-identical and the
new code path is never entered. The drain endpoint and the cron script both refuse cleanly
with *"Google Drive storage is not enabled on this deployment"*. Test file cleaned up.

## [Drive Storage — Phase 5] — 2026-08-01 — The thing that actually moves files

The first phase that writes to Google Drive. Assumes a single Shared Drive, as agreed.

The design premise: **a migration tool that works when everything works is worth very
little.** The interesting questions are what happens when a retry runs, when the process
dies mid-transfer, when Drive rejects an upload, and when someone wants it all put back. So
that is what most of this is, and what most of the 22 new tests are about.

### The flow

```
claim the item atomically
   ↓ already in Drive and verifies?  → skip, never re-upload
   ↓ hash the local file (SHA-256 + MD5, one pass)
   ↓ SHA-256 disagrees with the database?  → LOCAL_CORRUPT, nothing is uploaded
   ↓ mirror the folder path, root → leaf, lazily
   ↓ open a recovery row                        ← BEFORE any Drive write
   ↓ search Drive for an orphan from a crashed run; adopt it if found
   ↓ resumable upload, MD5 checked against Drive's own
   ↓ mismatch? → delete the remote object, VERIFY_MISMATCH
   ↓ commit the record, close the recovery row
   ↓ LOCAL COPY UNTOUCHED
```

### Four independent layers against duplicates

They are independent because each covers a failure the others cannot see:

1. **Atomic claim** — `findOneAndUpdate` with the status in the filter. Two workers cannot
   hold one item; the loser gets `null` and moves on.
2. **Unique index** on `FileVersion.googleDriveFileId` — the database refuses a second Drive
   file for one version even if every layer above has failed. This is the layer that is
   still working when the worker has just crashed, which is the only reason it is the layer
   that matters.
3. **Pre-flight adoption** — a version already recorded as migrated is *checked*, not
   re-uploaded. Covers a retry after a response was lost.
4. **`appProperties.idempotencyKey`** — covers the genuinely hard case, and the reason the
   recovery row goes in before the Drive call: the process dies *after* Drive commits and
   *before* MongoDB does, so nothing in the database points at the object. Without this, the
   retry uploads again and company storage gains an orphan for every crash.

There is a test for each, including one that rewinds the database while leaving the Drive
object — which is exactly what that crash produces — and asserts the second run adopts it
and creates **no second object**.

### Corruption is caught before it is propagated, not after

The local file is hashed *before* anything is uploaded, and refused if SHA-256 disagrees
with what was recorded at upload time. That costs a second read of the file — once to hash,
once to upload — and it is worth it: verifying a corrupt copy against itself after the
transfer would record the corruption as correct.

MD5 is computed in the same pass because Drive publishes MD5 and no SHA-256, so it is what
the round trip can be checked against later without re-downloading anything.

### Rollback is a field flip, and it is tested

No bytes move. The Drive objects are deliberately **left in place** — deleting them would
make the rollback itself the destructive act. A version whose local copy has already been
deleted is **skipped**, not flipped: pointing the record at bytes that are not there would
turn a recoverable situation into data loss, and the audit entry for a rollback with skips
is raised to `critical`.

The acceptance criterion — roll back a migrated project and re-download every file — is a
test, not a promise.

### Failure behaviour

A failed transfer leaves the version **entirely untouched**: `storageProvider: 'local'`, no
Drive id, `migrationStatus: 'not_started'`, and the file still downloads. A migration tool
that half-updates a record on failure is worse than one that fails.

Failures carry machine-readable codes (`LOCAL_MISSING`, `LOCAL_CORRUPT`, `VERIFY_MISMATCH`,
`FOLDER_TOO_DEEP`, `DRIVE_QUOTA_EXCEEDED`, …) which the dashboard groups and translates into
something an administrator can act on. A `429` stands the **whole job** down for a cooldown
rather than retrying tightly: Drive's quota is shared with every interactive upload and
download, so employees win.

### The two external ceilings, reported before anything moves

- **R1** — the Shared Drive's 500,000-item limit, which cannot be raised. Every version *and
  every mirrored folder* is an item, so the plan projects the total and warns at 350,000.
- **R2** — Drive allows 20 folder levels; this application allows 32. A dry run lists every
  folder too deep to represent, by name, so the tree can be flattened first rather than
  discovered as a run of failures half way through.

### Folder mirroring
Lazy — created the first time content needs to land in one. Eager creation would put a
failable remote call into `POST /api/folders` and produce tens of thousands of empty Drive
folders against that item limit. Adoption is by our own stamped `appFolderId`, **never by
name**: Drive happily allows two siblings with the same name, so a name match would write
research data into whatever folder shared a label. A lost mirroring race re-reads the
winner's id rather than scattering one folder's contents across two.

### Added
- `StorageMigrationJob` / `StorageMigrationItem` repository with the atomic claim, plus
  stale-claim release — a crash otherwise leaves rows permanently claimed and the unique
  index becomes a deadlock instead of a safeguard.
- `planner.ts` — paged selection by folder / department / project / type / date range /
  explicit ids. **Refuses an unbounded selection**: "migrate everything at once" is the
  thing the phase plan exists to prevent.
- `folder-mirror.ts`, `transfer.ts`, `runner.ts` (bounded concurrency, pause, verify-only,
  rollback), `storage-migration.service.ts`, nine API routes, and an admin dashboard.
- The dashboard speaks plainly — "Move files to the Shared Drive", "Put files back",
  "Check what would move". No employee ever sees it; §19 keeps this in the admin area.

### Changed
- The admin tabs now read **"Import from Drive"** and **"Drive storage"**. Two pages both
  called "Migrations", running in opposite directions, is exactly the confusion §3 of the
  Phase 0 analysis warned about — and it stopped being hypothetical the moment the second
  one existed.

### Tests — 570 passing (up from 548)
22 new, all against the real pipeline: files uploaded through `upload.service`, planned by
the real planner, transferred by the real worker against an in-memory Drive. No shortcut
that fabricates a migrated record, because a shortcut would skip precisely the guarantees
being asserted.

An existing guard caught a real mistake: `route-protection.test.ts` failed because the nine
new admin routes gated only in the service layer. The codebase's rule is that the gate must
be visible *where the endpoint is defined*, so `assertCompanyPermission(actor,
'access.manage')` is now in every route as well as the service.

### Verified in the running server
A dry run over a folder with real content reported 3 versions, 129 bytes, 1 folder, 0 too
deep, 4 projected items of 500,000 — and wrote **no item rows**. The same selection in
`migrate` mode wrote 3. Running it refused with *"Google Drive storage is not enabled on
this deployment"*, which is correct: nothing can move until a real Shared Drive is connected.

### Not verified
Nothing has run against a real Google account. Every Drive interaction here is exercised
against the in-memory fake. Phase 2's manual checklist has to be completed before Phase 10
moves a single production file.

## [Drive Storage — Phase 4] — 2026-08-01 — Reading from either place

Phase 1 made reads ask the record which storage owns its bytes. Phase 3 gave the record
somewhere to answer from. This is where a file whose bytes are in Google Drive actually
opens — and, more importantly, where the read paths learn to survive the two things that
only exist once content really lives somewhere else.

Most of the work turned out to be already done. `getStorageLocation()` has returned a
locator since Phase 1 and every read path already resolved its provider from it, so no read
path needed rewriting. What was missing was everything that happens when Drive does not
behave.

### The Drive object is gone — and the download still works

Someone empties the Shared Drive trash. Thirty days later the objects are unrecoverable.
§16 of the brief is specific: never delete the MongoDB record, mark the storage state,
notify an administrator — and this is the part that only works because of a decision made
three phases ago — **serve the retained local copy**.

`storageKey` staying `required` and never cleared looked like redundancy when Phase 3
shipped. It is what lets an employee keep working through somebody else deleting the
company's Drive folder. The record is marked `syncStatus: 'conflict'`, an audit entry names
the employee whose download discovered it, and the download returns the right bytes.

When there is no local copy either — a version whose retention window has passed — the read
fails with a plain "currently unavailable", the record **still** survives, and it is still
marked. A file that has lost its bytes keeps its metadata, comments, reviews, approvals and
audit history. Losing those too would turn a storage incident into a compliance one.

### "Absent" is not the same as "not right now"

The fallback hinges on one predicate, and it is deliberately narrow. Only a Drive `404` and
a local `ENOENT`/`ENOTDIR` count as missing. A `403`, a `429`, a `500`, a timeout, an
`EACCES` on a mount that came back read-only — none of them do.

Getting this wrong is expensive in both directions. Too broad, and a five-minute Google
outage marks thousands of healthy versions as conflicts and pages somebody about data loss
that never happened. Too narrow, and a genuinely deleted object surfaces as a 500 while the
record goes on claiming everything is fine. 16 tests, most of them about what must *not*
count.

### Google-native documents

A Doc has no bytes. Asking Drive for them returns `403 fileNotDownloadable`, which tells a
user nothing. Reading one is now an *export*, and that changes three things the response
has to get right:

- **The extension.** An exported Doc is a `.docx`. Handing somebody a file named `Protocol`
  with the stored `.txt` extension is how a file becomes unopenable.
- **The length.** Unknown until the export exists. `Content-Length` is now **omitted**
  rather than sent as `location.size` — which is 0 for a native document, and would make the
  browser save an empty file. `FileStream.contentLength` became `number | null` for this.
- **Ranges.** A generated export has no stable byte range, so `Accept-Ranges: none`, and a
  range request is answered `200` with the whole body rather than a `206` that lies about
  what it contains.

One fixed export format per kind — Office formats, not PDF, because they are what people go
on to edit. Not a user-facing choice: asking a bench scientist to pick between six MIME
types on the way to opening a protocol is not a feature.

### Changed
- `stored-content.ts` — new. All of the above lives here so `download.service` keeps reading
  as "resolve, open, stream". It is **read-only**: it never repairs, re-uploads or deletes,
  because a read path that mutated storage would make every download a potential data-loss
  event. The one write is marking the conflict, which is metadata about the failure.
- `getStorageLocation()` now also carries `isGoogleNative`, `googleNativeKind` and
  `localCopyState` — the last of these is what tells a failing read whether a fallback exists.
- `markStorageConflict()` — new, and deliberately incapable of deleting anything.
- `file-response.ts` — omits `Content-Length` when unknown; `Accept-Ranges` follows the content.

### Unchanged, deliberately
The integrity sweep still reads *without* the fallback. Its job is to verify the stored
object; quietly reading the local copy instead is precisely the bug it exists to catch.
Quarantine, chunk assembly and capacity stay local-only — those are Phase 6's problem and
D1 says they stay local permanently anyway.

### Tests — 548 passing (up from 521)
27 new. The integration suite uploads a file through the *real* pipeline, copies its bytes
into an in-memory Shared Drive and flips the record — which is exactly what Phase 5 will do
— then asserts the read is byte-identical, the range still works, the ETag and
Content-Disposition are unchanged, and a stranger is still refused without a single Drive
call being made on their behalf.

One test failure during development was worth having: the fake Drive restarted its ids per
test while the database persisted, and the **Phase 3 unique index rejected the duplicate**.
The constraint working before any migration code exists is the best evidence it will work
when one does. The fake now issues globally unique ids, as real Drive does.

### Verified in the running server
The pre-Phase-3 file still downloads (71 bytes), previews, and answers `206` with
`content-range: bytes 0-9/71` and its SHA-256 ETag — byte- and header-identical to before.

## [Drive Storage — Phase 3] — 2026-08-01 — Somewhere to write it down

Every field the migration needs, and **no behaviour change whatsoever**. Purely additive:
no field removed, renamed or made required; no query rewritten; no service touched. The
application behaves exactly as it did this morning, and 521 tests say so.

### Added — fields on the three existing models

`FileVersion` gains where its bytes are (`storageProvider`, `googleDriveFileId`,
`googleDriveParentId`, `googleDriveRevisionId`, `googleDriveMd5`, `googleDriveWebViewLink`),
how far through migration it is (`migrationStatus`, `migratedAt`, `migrationFailureReason`),
whether it agrees with Drive (`syncStatus`, `lastSyncedAt`), what happened to the local copy
(`localCopyState`, `localCopyEligibleForDeletionAt`), and whether it is a Google-native
document at all (`isGoogleNative`, `googleNativeKind`).

`Folder` gains its Drive counterpart and mapping state. `File` gains **only a category** —
`storageProvider` including a `mixed` value, and `hasGoogleNativeContent`. No Drive id is
stored on `File`, preserving the rule that a file listing cannot leak a physical address
however carelessly it is serialized. A test asserts the absence.

`storageKey` stays **required, unique and never cleared**. After migration a version carries
*both* addresses, and that redundancy is the entire rollback mechanism: reverting to local
storage is one field change with no data movement.

### The blocker Phase 0 predicted, and how far it was opened

`file-version.model.ts` has a hook that throws on any update outside `MUTABLE_PATHS`. Every
new field was outside it, so the migration could not have written a single one — invisible
until the first write failed mid-run.

Widened, and **narrowly**: storage-location and lifecycle fields are now mutable;
content-identity fields are not. `checksumSha256`, `fileSize`, `mimeType`, `extension`,
`originalFilename`, `versionNumber`, `fileId` and `storageKey` all still throw. The property
the hook exists to protect — the bytes a reviewer approved cannot be swapped underneath the
approval — is untouched, because "the same bytes now also live over there" says nothing
about what those bytes are. A migration that could rewrite a checksum could hide a corrupt
transfer by recording the corruption as expected; there is a test for each forbidden field
and a comment saying not to widen it further.

### Added — four collections, deliberately not the ones that already exist

`StorageMigrationJob`, `StorageMigrationItem`, `StorageRecoveryItem`, `DriveSyncState`.

The `Storage` prefix is load-bearing. `MigrationJob`/`MigrationItem` already exist and are
the *inbound* Drive importer — read-only, opposite direction. Sharing them would put a
write-capable organization-wide storage backend inside documents keyed for an importer;
their counters would corrupt each other and their audit trails would be indistinguishable.
Same reasoning gives the new audit actions a `storage_migration.*` / `drive_storage.*`
prefix rather than extending `migration.*`.

`StorageRecoveryItem` is the one worth reading. A row is written **before** any Drive
mutation and cleared **after** the matching database commit, so anything left in it is an
operation that got part-way. It exists for one case: the process dies after Drive commits
and before MongoDB does. Nothing in `FileVersion` then records that upload, and without this
row every crash leaves another orphan in company storage.

### The guarantees are indexes, not intentions

- `FileVersion.googleDriveFileId` — **unique**, partial on `$type: 'string'`. A retry that
  would record a second Drive file for one version fails *at the database*, which is the
  layer that is by definition still available when the worker has just crashed. Partial, so
  the thousands of unmigrated versions do not all collide on null.
- `Folder.googleDriveFolderId` — unique, partial. Makes "reuse the folder, never create a
  second" an enforced invariant. There is deliberately no index on folder *name*: matching
  by name would adopt a folder somebody created by hand for something else.
- `StorageMigrationItem.versionId` — unique, partial on `claimActive`. Two overlapping jobs
  cannot transfer the same version; only one could win the index above and the other would
  leave an orphan. Keyed on a maintained boolean rather than a status list, so the
  constraint cannot drift if the status vocabulary grows.
- `StorageRecoveryItem.idempotencyKey` — unique among open rows, so a retry re-entering the
  same code path finds the existing row instead of racing itself.

19 indexes, all verified against a live MongoDB 8.2 and pinned to mongo:7 in production
(`$in` in a partial filter needs 6.0+; checked before writing them, not after).

### Added — `scripts/db/2026-08-01-storage-provider-fields.ts`

Two deliberate non-actions, both documented in the file:

**No backfill.** Not one `updateMany`. Mongoose applies a schema default on *read* for an
absent path, so a version written in July already behaves as `local` / `not_started` /
`present` without being rewritten. Writing 100k documents to store values that are already
their defaults would take a long write lock and buy nothing. Verified directly: a document
inserted through the raw driver with none of the fields reads back with all the right
defaults *and is still absent from disk afterwards*.

**No drops.** `createIndexes()`, not `syncIndexes()` — the latter also drops every live index
not currently declared, which in a migration script is a foot-gun pointed at production.

Run twice against the live database: 19 created, then `Nothing to do — all 54 declared
indexes already exist`. Also asserted by a test.

### Tests — 521 passing (up from 487)
34 new. The integration suite runs against a real MongoDB because every guarantee here is
enforced *by* MongoDB — what a partial unique index rejects, whether a default materializes
on a document that predates the field. A mock would assert my own assumptions back at me.

Legacy documents are inserted through the raw driver rather than Mongoose, so the new paths
are genuinely absent rather than written with their defaults — which is the only way the
backward-compatibility claim means anything.

### Verified in the running server
A file created 2026-07-30, two days before these fields existed, downloads (71 bytes,
correct), previews, ranges and lists its versions. Its API responses contain **none** of the
new fields — the DTO layer is an explicit allow-list, and there are now tests pinning that
for both the file and version DTOs. All 13 pages and the whole API surface still 200.

### Not done in this phase, by design
Nothing reads or writes any of these fields yet. Dual-storage reads are Phase 4, the
migration tool Phase 5, uploads Phase 6, sync Phase 9. `DriveSyncState` in particular is
created now purely so Phase 9 is a worker rather than another schema change.

## [Drive Storage — Phase 2] — 2026-08-01 — Something behind the seam, still unplugged

Phase 1 built the seam. This fills it: a working Google Shared Drive provider that can
create, upload, stream, rename, move, trash, restore and copy. It is **off by default and
in no production path** — `GOOGLE_DRIVE_STORAGE_ENABLED=false` means not one line of it
runs, and a deployment with the flag off makes no Google call at all, asserted by a test.

### Added — authentication, and why this one

**Service account as a direct member of the company Shared Drive.** Not domain-wide
delegation, which would let a single environment variable impersonate any employee in the
Workspace domain — a leak would be a full-domain compromise rather than a Drive
compromise, and nothing here needs impersonation because MongoDB remains the authoritative
permission model. Not admin OAuth either, which is right for the *inbound* importer
(interactive, temporary) and wrong for a permanent backend: refresh tokens die when the
granting admin changes their password or leaves, and "all uploads stop company-wide because
someone left" is not an acceptable failure mode. A service-account membership has no such
lifecycle, files it creates are owned by the Shared Drive rather than a person, and access
is revoked in one click.

The cost, recorded rather than glossed: this one key reads and writes every research file.
So `*_PRIVATE_KEY_FILE` (a mounted secret) takes precedence over the inline variable, an
inline key in production is a warning on the admin page, and `drive-config.ts` is the only
module in the codebase that reads it — asserted by a test that enumerates the readers.

### Added — the provider

- `GoogleDriveHttpClient` — the one module that speaks HTTP to Google. No route, service or
  repository issues a Drive request. `google-auth-library` handles JWT signing and token
  caching; the REST calls are hand-written `fetch`, matching the existing importer.
- `GoogleDriveObjectStore` — `ObjectStore` + `HierarchicalStorageProvider`. Receives no
  actor, no request and no Mongoose model: authorization stays entirely in services, and a
  second, divergent permission model here would be worse than none.
- `WritableObjectStore` — a **separate** interface from `ObjectStore`, so the local path
  does not gain a second write surface that could bypass quarantine, signature checks and
  the malware scan.
- `checkDriveConnection()` — metadata calls only. A probe object written on every readiness
  poll would pollute the Drive activity log administrators need to read.

### The parts worth arguing about

**Resumable uploads for every size, not just large ones.** Not for the chunking — for the
fact that an interrupted transfer can be *asked* how many bytes actually landed. Before
every chunk retry the session is queried, because a failure after Drive committed and
before the response arrived is indistinguishable from one where nothing arrived, and
replaying blindly writes bytes at an offset the server has already filled. Both of those
cases have tests; both produce a corrupt or duplicated file if the query is removed.

**Uploads verify before they are believed.** MD5 and SHA-256 are computed in the same pass
as the transfer, so verification costs no extra I/O. MD5 is compared against Drive's own
`md5Checksum` — a mismatch **deletes the remote object** and fails, because a file at a real
Drive id that nothing points at and nothing verified is exactly what the local copy would
later be deleted in favour of.

**Folders are adopted by a stamped id, never by name.** A crash between "Drive created the
folder" and "MongoDB recorded it" leaves an orphan; searching `appProperties.appFolderId`
finds and reuses it, so a retry converges instead of adding a duplicate every attempt.
Matching by name would happily write research data into a folder somebody created by hand.

**A 403 is not retried unless Google names a rate limit.** Drive uses 403 for both "slow
down" and "you may not do that", distinguished only by `reason`. Retrying a permissions
failure five times against the whole company's storage burns quota that interactive uploads
share and delays telling the user the truth.

### Added — visibility, split by audience

`/api/health/ready` gains a `drive` block of exactly three fields — `status`, `enabled`,
`connected`. It is unauthenticated, so it carries no drive id, no drive name, no service
account and no Google error text; a test asserts the field list exhaustively so adding a
fourth is a decision somebody has to make on purpose. A broken Drive is `degraded` rather
than `error` while `DEFAULT_STORAGE_PROVIDER=local`, because it blocks migration and
nothing else — taking the instance out of the load balancer would stop employees working on
local files that are fine.

`/api/admin/storage/drive` and a panel on `/admin/system` carry what is actually needed to
*fix* a connection: drive id, root folder, service-account address, Google's own message.
Both are behind company-scoped `audit.view`. The panel says plainly that Drive's own "last
modified by" will show one name on every file, because the activity pane will otherwise
mislead the first administrator who opens it.

### Changed
- `env.ts` — the Drive variables, and five boot-time refusals. `DEFAULT_STORAGE_PROVIDER=`
  `google_drive` with the backend off, an enabled backend missing a drive id / service
  account / key, and `DELETE_LOCAL_AFTER_MIGRATION=true` with zero-day retention all refuse
  to boot. Storage is the one subsystem where "start anyway and fail on first use" risks
  losing bytes.
- Storage registry now registers Drive when enabled and applies `DEFAULT_STORAGE_PROVIDER`.
  **Note for Phase 6:** the upload pipeline still writes through `getStorageProvider()`, so
  setting the default to `google_drive` today changes what the registry reports, not where
  bytes land.

### Tests — 487 passing (up from 402)
85 new, all offline. `FakeDriveClient` is an in-memory Shared Drive that 404s on unknown
ids, computes its own MD5 from bytes it actually received, and refuses `alt=media` on a
Google-native document — a permissive fake would make the provider's error handling
untestable, which is the part most worth testing. The resumable state machine is tested
against a stubbed transport modelling `308 Resume Incomplete` and `Range:` accounting,
including the two lost-response cases.

`local-storage-provider.test.ts` (20) and `architecture-boundaries.test.ts` (3) pass
**unmodified and unwidened** — the Drive code lives under `src/server/storage`, so the
filesystem-confinement rule needed no relaxation.

### Not done in this phase, by design
No schema fields (Phase 3), no dual-storage reads of Drive-backed records (Phase 4), no
migration (Phase 5), no uploads routed to Drive (Phase 6), no sync (Phase 9). Nothing was
verified against a real Google account: this machine has no service account, and the
acceptance criterion "create, upload, stream, rename, move, trash, restore work in a test
folder" is met against the fake. It needs one manual pass against a real Shared Drive
before Phase 5 — the steps are in `docs/storage-migration/02-phase-2-google-drive.md`.

## [Drive Storage — Phase 1] — 2026-07-31 — A seam, and nothing behind it yet

Groundwork for moving file bytes from this server's disk to a company Google Shared Drive.
Phase 1 introduces the seam only: no Google code runs in any production path, no schema
changes, no behaviour change. The audit that decided the approach is in
`docs/storage-migration/00-phase-0-analysis.md`.

### Added — provider-agnostic object access

- `StorageLocator` — where one stored version actually is. Deliberately carries *both*
  addressing schemes: `key`+`area` (local) and `externalId` (a Drive file id). The local
  key is never cleared once an object is copied elsewhere, which is what makes reverting a
  file to local storage a single field flip with no data movement.
- `ObjectStore` — the surface the application uses for durable content. Every method takes
  a locator, never a bare key, so a call site cannot read an object without having said
  which provider owns it. There is no default location to fall back to.
- `HierarchicalStorageProvider` — folder mirroring, kept separate because it is a genuinely
  different capability: a local folder has no storage-side existence at all.
- `StorageRegistry` — name → implementation. Absent means `local`, because every version
  document written so far has no provider field and must keep working with no backfill.
  **An unregistered provider throws.** A record claiming to live in Drive on a deployment
  without Drive must fail loudly; falling back to the local key would serve whatever stale
  copy happens to still be on disk and report it as a successful download.
- `LocalObjectStore` — a thin adapter over the existing `LocalStorageProvider`. It refuses
  a locator naming another provider rather than reading the local key, which is the exact
  failure that retained local copies would otherwise make silent after migration.

### Changed — reads resolve their provider from the record

Download, preview, version restore, file copy, trash purge and the integrity sweep now ask
the record which storage holds its bytes instead of assuming. All still resolve to local.
`getStorageLocation()` returns a locator; `getStorageLocationsForFiles()` and
`listStoredObjects()` carry the provider through.

`LocalStorageProvider` itself is **unmodified** — the one module in this codebase that
touches the filesystem is untouched by this migration, so nothing that works today can
regress because of it. Its 20 existing tests pass unchanged, as does the
architecture-boundaries guard, unwidened.

## [Usability 2] — 2026-07-31 — The gestures people already know

Tier 1 fixed what was broken. This adds what was never there: the interactions someone
brings with them from every other file manager and finds missing here. Verified absent
beforehand by search — no `onContextMenu`, no `draggable`, no selection state, no undo,
no shortcuts anywhere in `src/`.

### Added — multi-select and bulk actions

The single biggest drag on daily use: moving forty sequencing files meant opening the
"Move to…" dialog forty times.

- Checkboxes on every row, Ctrl/⌘-click to add one, Shift-click to take a range,
  Ctrl/⌘+A for the page. `useSelection` keys items as `folder:<id>` / `file:<id>` so the
  two kinds share one set without an id collision ever selecting the wrong thing.
- A selection bar **replaces** the sort/view toolbar rather than stacking above it —
  nobody reaches for sort order with twenty files highlighted. Move, Star, Trash only;
  bulk rename is not a thing anyone does, and offering it would bury the three that are.
- **Bulk actions run sequentially and report honestly.** Twenty parallel moves make the
  server race itself over one destination, and a failure inside a parallel batch cannot be
  attributed to anything the user can act on. Mixed selections routinely half-succeed —
  permissions differ per item and an approved file cannot be moved — so the result is
  "Moved 12 of 14" with the server's own reason, never a flat "Done".
- The selection is cleared on folder change and on paging. Otherwise its ids survive into a
  list where they are no longer visible, and a bulk action operates on things off screen.

### Added — undo, replacing one of the two confirmations

Deleting a *file* is now immediate with an Undo action on the toast. A confirmation before
a reversible action is the wrong instrument: people learn to dismiss it unread, and it
cannot help once they have clicked through. Undo can.

Deleting a *folder* keeps its dialog — "everything inside goes too" is a consequence you
cannot see from the row you clicked, so it is worth a sentence. Moves are undoable too:
the source folder is known, so undo is just the move backwards.

### Added — right-click menus

The first thing anyone tries on a file, and until now nothing happened. Built from the same
groups the ⋮ button renders — `fileActionGroups` / `folderActionGroups` are now the single
description, and each menu renders it with its own Radix primitive, because the two cannot
share a subtree but must never offer different actions.

Right-clicking inside a multi-item selection shows the bulk actions and says how many are
selected. "Delete" meaning "delete one of the twelve things I have highlighted" is how
people lose work.

### Added — drag to move

Rows are draggable onto folder rows, and onto the breadcrumb path to move *up* — without
that, dragging could only ever move things deeper.

The dragged keys are held in a ref because `dragover` may only inspect the data transfer's
*types*, never its payload; without it a folder cannot tell whether it is one of the things
being dragged onto itself. Internal drags carry `application/x-drive-items`, and the upload
dropzone already ignored anything without `Files` — so the two drag systems never collide.

### Added — keyboard shortcuts, and a way to find them

`/` jumps to search, `?` opens the shortcut list, `Esc` clears a selection, `Delete` trashes
it. Shortcuts nobody can discover are shortcuts nobody uses, so `?` — the convention — opens
a dialog listing all of them including the mouse gestures.

Handlers ignore keys typed into inputs, and ignore everything while a dialog is open;
`alertdialog` is in that check specifically so Escape closing the trash confirmation does
not also wipe the selection it was about to act on.

### Added — "Open folder", and sharing a file from the list

Search, Starred, Recent and Shared all reach a file without ever showing where it lives.
The details panel now has the way back. The file ⋮ menu also gained **Share**, which it had
always lacked while the folder menu had it — a file could only be shared by opening its
details panel first.

### Notes
- New dependency: `@radix-ui/react-context-menu`, same family as the menus already in use.
  `ui/checkbox.tsx` is deliberately a native `<input>` — real checkbox semantics, the space
  key, and an indeterminate state screen readers announce as "mixed", with no extra package.
- 382 tests, typecheck, lint and `next build` all pass. Still nothing verified by hand:
  this machine has no Docker and nothing listening on 27017.

## [Usability 1] — 2026-07-31 — Making it behave like a drive

A review of the product against "could a bench scientist use this without being told how"
found the backend sound and the last mile of the UI unfinished. This is the first of four
passes and covers only the things that were **wrong**, not the things that were missing.

### Fixed — Starred, Recent and Trash discarded every file

The highest-severity defect in the product. `/api/starred`, `/api/recent` and `/api/trash`
have always returned `{ folders, files }`; the view rendered `folders` and dropped `files`
on the floor. So starring a file showed "Added to Starred" and then an empty Starred page,
and **a trashed file could not be restored from anywhere in the UI** — `useRestoreFile()`
and `POST /api/files/:id/restore` both existed, with no caller.

- `FolderCollection` is replaced by `DriveItemCollection`, which renders both. The old
  component is deleted rather than left beside the new one; a folders-only list sitting
  next to a list of both is how this happened in the first place.
- Trash restores files as well as folders. Starred can unstar in place — the page somebody
  goes to when they want to undo a star was previously a dead end that sent them hunting
  for the original folder.

### Fixed — navigating away cancelled uploads in flight

`useUploader()` was created **inside** `DriveBrowser`, and its unmount cleanup aborts every
open `AbortController`. Leaving the folder page therefore killed the transfer — the exact
thing `upload-tray.tsx` promises will not happen ("navigating away mid-upload must not
cancel it"). The uploader now lives in `UploadProvider` at the shell level, so it outlives
navigation, and the tray is rendered there with it so it keeps reporting on pages that have
no folder view.

### Fixed — nowhere to upload from except inside a folder

The sidebar offered **New folder** and nothing else, so anyone on Home, Recent, Search or
Starred had no way to add a file without first working out which folder to open. Replaced
with a **New** menu (upload files / upload a folder / new folder), reused on the Home page.

Where the files go is decided by asking, not guessing: the menu dispatches a synchronous
`drive:upload-target` event, an open folder browser answers with its own id if the viewer
may write to it, and My Drive is the fallback — with a toast saying so, because filing
somebody's data somewhere they did not choose is worse than an extra sentence. The
`window.location.href = '/my-drive'` full page reload in the old handler is gone.

### Fixed — version notes could be read but never written

Every version list displayed `versionNote` and there was no UI that set one, so the field
was permanently empty and history read as an anonymous stack of numbered files.
"Upload new version" now opens a dialog that shows which version is being replaced, warns
when the picked file has a different name from the file it will version, and asks what
changed. **Optional deliberately** — blocking on a text box teaches people to type a full
stop, and a wrong note is worse than no note.

### Changed — Home is a landing page, not a build tracker

It greeted employees with "Build progress — Phase 1 (foundation) is in place", four cards
labelled by phase number, an architecture reference pointing at `docs/phase-0/`, a link
whose text was `docs/phase-0/04-storage.md` and whose href was `/home`, and a card
reporting MongoDB ping latency and free disk percentage. It now answers what is waiting on
you, what you were doing, and where your files live — in that order, because only the first
has a deadline. `SystemStatusCard` is no longer mounted; Admin → System already reports the
same thing behind an `audit.view` check.

### Changed — build phases removed from the navigation

Nav items rendered a `P12` badge and `title="Available in Phase 12"`. Roadmap milestones are
internal vocabulary. `CURRENT_PHASE` moved to `src/lib/build-info.ts`, which also stops
`/api/version` importing a React component to find it.

### Notes
- 382 tests, typecheck, lint and `next build` all pass. Nothing was verified by hand in a
  browser: this machine has neither Docker nor a running MongoDB.
- The file-picker clicks in the New menu are deferred one tick. Radix closes the menu and
  restores focus during `onSelect`, which can swallow a picker opened in the same task; a
  zero timeout is still inside the browser's transient activation window.

## [Tooling] — 2026-07-30 — 🛠 DEV user switcher (development builds only)

### Added
- A floating **🛠 DEV** panel, mounted in the root layout so it is present everywhere
  including `/login` — which is exactly where switching accounts is most useful. Shows the
  current user and role, lists the seeded accounts with their highest-ranked role and
  department, and switches with one click. Sign-out and a dev-hub link (shown only when
  the actor can reach it) sit in the footer.
- `GET /api/dev/users` and `POST /api/dev/switch-user`, both gated by
  `assertDevToolingEnabled()`.
- `ENABLE_DEV_SWITCHER` — on by default outside production, `false` for a staging box that
  should behave like production without being a production build.

### Security decisions
- **The switch issues a real session** through the same `issueSession` the password login
  uses. A switcher that faked an Actor in React state would prove nothing about the thing
  it exists to test — permission checks, audit records and the immediate-deactivation
  guarantee all have to behave exactly as they would for a genuine sign-in.
- **Production is closed three ways**, and the innermost one is the real boundary: the
  routes 404 (`isDevToolingEnabled()` is false whenever `NODE_ENV === 'production'`), the
  panel is never rendered because the mount is a *server* component, and the process
  **refuses to boot** if a production configuration sets `ENABLE_DEV_SWITCHER=true`.
  Silently ignoring that variable would leave whoever set it believing it worked.
- **404, not 403.** A 403 confirms the endpoint exists and is merely refused, which tells
  an attacker which build they are talking to. 404 makes a production deployment
  indistinguishable from one where the feature was never written.
- **Not arbitrary impersonation.** The target must appear in the list the service itself
  publishes; resolving the id straight against the database would accept any ObjectId in
  the collection. Only active users are listed — a session for a deactivated account would
  be killed on the next request, which looks like a switcher bug rather than the correct
  behaviour it is.
- **No credential ever moves.** Passwords are not read, compared or returned. The session
  token reaches the browser only as the same HttpOnly cookie a real login sets and never
  appears in a response body, so it cannot be copied out of the network tab.
- The gate is asserted in the **service** as well as the route, so a future server action
  or script that calls the service directly cannot bypass it.
- Switching revokes the outgoing session rather than orphaning it — otherwise a morning of
  switching leaves a dozen live sessions behind and quietly undermines "sign out
  everywhere".

### Excluded from the production build entirely
Not merely disabled — **absent**. Two mechanisms, because routes and components need
different ones:
- Route files are named `route.dev.ts`, and `pageExtensions` registers the `dev.*`
  extensions only outside production. Next never resolves them in a production build, so
  they are never compiled.
- The panel is replaced with a render-nothing stub via `NormalModuleReplacementPlugin`.
  `resolve.alias` does **not** work here — Next resolves the `@/*` tsconfig paths through a
  resolve plugin that runs before webpack's alias stage, so an alias keyed on
  `@/components/…` is never consulted. Dead-code elimination does not work either: webpack
  emits the chunk while building the module graph, before it minifies, so an `import()`
  under a statically false branch still ships. Both were tried and measured before landing
  on the plugin.

Verified by grepping the built artifact: `Development switcher`, `data-dev-switcher`,
`dev-switcher`, `switch-user` and `assertDevToolingEnabled` all return **zero** matches
across `.next/static` and `.next/server`.

### Tests — 382 passing (up from 369)
11 gate tests (production boot refusal for both `true` and `1`, normal boot when absent or
false, default-on outside production, 404-not-403, and the service refusing to list or
switch behind a shut gate) plus two structural tests: **every** route under `/api/dev` must
call `assertDevToolingEnabled()` *before* it awaits anything, and every one of them must be
named `route.dev.ts` with `next.config.ts` gating the extension on NODE_ENV. Renaming one
back to `route.ts` would ship an anonymous session-minting endpoint in the production
artifact and nothing else in the suite would notice — the runtime gate would still 404, so
it would look fine.

### Verified in running servers
Development: the panel renders on `/login` and `/home`; `/api/dev/users` lists three seeded
accounts with no secrets; a switch issues a working session that `/api/auth/session`
accepts; an unlisted-but-well-formed object id is refused with 404; `{"userId":{"$ne":null}}`
is a 422, not a query operator; the response body contains no token.
Production build on port 3100: both dev endpoints return **404** and the login page contains
no switcher markup at all.

## [Phase 11] — 2026-07-30 — Backup, security and production hardening

The phase's real subject is **silence**. Almost nothing Phase 11 guards against announces
itself: a backup job that stopped three weeks ago produces exactly the same dashboard as
one that ran an hour ago, an antivirus container that died looks identical to one with
nothing to find, and a disk at 94% looks like a disk at 40% until it doesn't. Everything
below exists to make one of those conditions say so out loud.

### Added

**Backups that report on themselves**
- `backup.sh` now writes `last-backup.json` on **every** exit path, success or failure,
  naming the stage that failed — "failed at `offsite_copy`" and "failed at `mongodump`"
  are different emergencies. Written atomically, because the application may read it
  mid-write and a truncated JSON document would be reported as "never ran".
- `restore.sh`: dry-run by default, restores files into a **staging** directory rather
  than over live storage, and refuses to drop a populated database without `--drop`. An
  automated restore that overwrites good data with older data is a second outage on top
  of the first.
- `verify-restore.sh`: the weekly drill. Restores the latest snapshot into a scratch
  directory, loads the database into a scratch database, samples file versions **from the
  restored database**, finds their bytes **in the restored tree**, and re-hashes them.
  Scratch artefacts are destroyed on every exit path including failure.
- A real schedule (`crontab`, `run-job.sh`, `entrypoint.sh`) — the previous prod compose
  started `crond` with no crontab installed, so nothing was ever going to run.
- `readBackupStatus` / `readRestoreDrillStatus` in the **storage layer**, where filesystem
  access belongs.

**Monitoring that does not wait for a browser**
- `system-checks.ts`: pure evaluation of every operational signal, separated from
  gathering so the judgements are testable without a database, a disk or a clock.
- `alerts.ts` + `AlertState`: alerts once, suppresses inside a severity-scaled cooldown,
  **breaks the cooldown on escalation**, and reports recovery exactly once. Cooldown state
  is in MongoDB rather than memory because the monitor is a new process on every cron run.
- `scripts/monitor.ts`, every 15 minutes, with exit codes an external monitor can read.
- `GET /api/admin/system` and an **Admin → System** page.

**Operations**
- `scripts/review-indexes.ts` — declared vs live indexes, redundant prefixes, `$indexStats`
  usage, index footprint.
- A `maintenance` Docker stage carrying the source and `tsx`. The runtime image is a
  standalone bundle with no `scripts/` directory, so the scheduled jobs literally could
  not have run in it. The `worker` service — which was a second copy of the web app under
  a different name — is now `scheduler` and runs the jobs.
- A ClamAV service on the internal network, and a `backup-status` volume that is writable
  by the backup container and **read-only to the application**.
- CI (typecheck, lint, test, build, both images, audit, committed-secret check) and a
  manual, environment-gated deploy that verifies storage integrity after every release.

**Documentation** — employee guide, admin guide, operations runbook, backup and restore
procedure, security hardening notes.

### Security decisions
- **The application cannot touch its own backups.** The backup container mounts the file
  volume read-only and the status volume is read-only in the other direction, so the
  entire channel between them is one small JSON file travelling one way. A bug in the
  application cannot damage what protects it.
- **A missing or unparseable status file reads as "never ran", not "fine".** Every unsafe
  default here points the same way: unknown is never healthy. The same reasoning makes an
  unreachable scanner critical whether it fails open (files stored unscanned) or closed
  (uploads refused) — only the explanation differs.
- **Upload authorization is rate-limited separately** from ordinary API traffic. The
  general 1000-per-15-minutes would allow 1000 upload sessions, each reserving quota and a
  quarantine slot until it expires. Counters are per-actor so one person's bulk import
  cannot lock their department out.
- **Search is rate-limited** — it is the most expensive read in the system and a scripted
  search loop is also how somebody probes for filenames they cannot open.
- **Restore drills verify the backup against itself**, never against the live database.
  Checking restored bytes against live metadata would prove nothing about whether the
  backup is internally consistent, and internal consistency is the only property that
  matters when the live database is gone.
- **Orphaned bytes are still never deleted automatically.** The one situation where that
  would be catastrophic is a partially restored database — exactly when the sweep is most
  likely to be run.
- The deploy workflow pins the SSH host key rather than disabling host verification, and
  **does not roll back automatically**: a half-rolled-back file volume is worse than a
  stopped deploy.

### Fixed
- `system.service.ts` imported `fs` directly, breaking the architectural rule that only
  the storage layer touches the filesystem — the one failing test at the start of this
  phase. Moved to `storage/backup-status.ts`.
- `restic restore latest` would have restored the **wrong snapshot**. Files and the
  database are backed up as two separate snapshots, so "latest" is whichever ran last —
  the mongo one. Both the restore script and the drill now select by tag; without this the
  drill would have passed having verified no files at all.
- The index review compared raw index keys, so every **text index** looked "declared but
  never built" — MongoDB stores them as `{_fts, _ftsx}` with the real fields in `weights`.
  Five collections would have reported a false alarm on every run, which is how a check
  earns the right to be ignored. Caught by the new index test.
- The backup container ran `crond` with no crontab, so no backup was ever scheduled.
- Bind-mounted shell scripts are invoked through an explicit interpreter: a read-only
  mount cannot be `chmod +x`'d, and the execute bit does not survive a Windows host.

### Tests — 369 passing (up from 329)
40 new tests. 26 on operational judgement: below the disk floor is critical rather than a
warning because uploads are *already* being refused; capacity that cannot be read warns
rather than reporting health; a backup that succeeded but stayed on the same machine gets
its own warning; a failed restore drill is critical while a never-run one is a warning;
and six cases on status files that are absent, unparseable, oversized, the wrong JSON
type, or carrying a timestamp that is not a date. 14 on abuse and hardening: the upload
limit refusing without reserving a single session, `Retry-After` on the refusal, one
user's limit not touching a colleague's, quota and free-disk-floor refusals costing
nothing, search limiting, alert suppression / escalation / recovery / independence, and
two index assertions covering every registered model.

### Verified
`npm test`, `npm run typecheck` and `npm run lint` clean. Docker Compose is still not
executable on this machine (noted since Phase 1), so the ClamAV, backup and scheduler
containers are authored and reviewed but not run; the logic they invoke is covered by the
suites above, and the compose graph is what the CI image build exercises.

## [Phase 10] — 2026-07-30 — Google Drive migration

### Added
- `MigrationJob` (connection, destination, options, counters, state machine) and
  `MigrationItem` — one row per scanned Drive file, whatever became of it. `(jobId,
  driveFileId)` is unique, which is what makes a re-scan idempotent.
- Read-only Drive client with `drive.readonly`, offline access (so a job resumes
  tomorrow), paged folder listing, binary download and Google-Docs export to Office
  formats.
- The pipeline mirrors the upload pipeline, because the trust problem is identical:
  **scan → stage → measure → verify → deduplicate → move → record**.
- Connect / scan / run / pause / retry / report, an admin UI that runs them step by step,
  and `POST/GET /api/admin/migrations` (+ `[jobId]`, `/connect`, `/scan`, `/run`,
  `/pause`, `/retry`, `/items`, `/report`).
- `sealSecret`/`openSecret`: AES-256-GCM with an HKDF-derived key, for the one secret the
  server must read back rather than compare.

### Security decisions
- **The originals are never touched, structurally rather than by policy.** The scope
  requested is `drive.readonly`, and every Drive call goes through one function that
  hard-codes `method: 'GET'`. There is no function in the client capable of a mutating
  request, so adding one would be a visible act rather than an accident. A test asserts
  both, by inspecting the source.
- Size and checksum are what *this server* measured while streaming. Drive's
  `md5Checksum` is kept as provenance and never used to decide equality — MD5 is not
  collision-resistant, exported Docs have none, and "the same bytes" is a claim this
  system makes on its own evidence.
- Imported bytes pass the same signature check uploads do. A `.pdf` in someone's Drive
  that is actually an executable is flagged for review, not imported.
- The refresh token is encrypted, excluded from the job record type, absent from the DTO,
  and read by exactly one named function — so "who can obtain it?" has a greppable answer.
  It is destroyed when the job is removed.
- Migration is gated on **company-scoped** `access.manage`, and the destination is
  additionally checked as an ordinary upload target: an administrator cannot import into a
  folder they could not upload a single file to by hand.
- Imported files take the destination folder's classification or stricter. An import can
  never make content more widely readable than the folder it lands in.
- The consent callback is a page, not an API route: the code arrives by browser
  navigation, and the exchange is then a same-origin request carrying both the session
  cookie and the CSRF header, with `state` bound to the browser that started the flow.
- `completed` is reserved for a job with nothing left *and* nothing wrong. Anything
  skipped or failed leaves the job in a state that says a human should look.

### Fixed
- `saveFile`'s `expectedSize` was the only length control and is an *exact* match, which
  cannot express "a stream of unknown length, up to this much" — the shape every external
  import has. Added `maxBytes`, which aborts mid-stream without requiring a declared size.
  The two compose: whichever is smaller wins.
- Scanning or running a `completed` migration was refused, so a finished job could never
  pick up files Drive gained afterwards — which is how a long move actually happens.

### Tests — 329 passing (up from 315)
14 migration tests against a recording Drive stub: every recorded interaction is a read;
the live client contains no mutating verb outside the OAuth token exchange; hierarchy,
dates and provenance preserved; a repeated scan importing nothing twice; duplicate bytes
skipped *and reported* with the file they matched; a disguised executable flagged for
review; an unsupported type reported rather than omitted; a Google Doc exported and named
with an extension; retry-after-failure without duplicating successes; no file record left
behind by a failed download; department head and scientist both refused; the credential
absent from a serialized job; and the sealed-secret box rejecting a tampered ciphertext.

## [Phase 9] — 2026-07-30 — Research organization

### Added
- `Experiment`: the anchor a file is traced back to — a code, a project, the people who
  ran it, the samples and protocol it touched, and a date. Deliberately thin. A LIMS
  would model runs, plates and aliquots; the brief is explicit that this must not become
  one, and "what produced this file?" is answerable without any of that.
- Files link to an experiment (`PATCH /api/files/[id]` gains `experimentId`). A file with
  no project inherits the experiment's, so *every* linked file can be traced to a project
  even when it was uploaded somewhere generic.
- **Related files** (`GET /api/files/[id]/related`) — one indexed query answering four
  questions: same experiment, same sample ID, same experiment code, and *the same bytes
  filed somewhere else*. Checksum matching is the only honest answer to the duplicate
  problem the brief opens with: identical content, whatever either copy is called.
- Project dashboard (`GET /api/projects/[id]/overview`): data by document type, review
  state, experiments, team, storage, recent activity, and the template folders the drive
  is missing.
- Administrator-editable folder and metadata templates, stored per organization with the
  seeded defaults as fallback (`/api/admin/templates/folders`, `.../metadata`, plus an
  admin page).
- `GET/POST /api/experiments`, `GET/PATCH/DELETE /api/experiments/[id]`; `experimentId`
  as a search filter; experiment picker in the metadata form; sample-ID chips that link
  straight to a search.

### Security decisions
- **An experiment has no ACL of its own — it inherits its project's.** Whoever can see the
  project sees its experiments; whoever may edit research metadata there may record them.
  A second permission surface would be a second thing to get wrong, and an experiment
  discloses far less than the files hanging off it. An experiment in a project you cannot
  see answers 404, not 403.
- Linking a file to an experiment is refused unless the actor works on that experiment's
  project. Otherwise linking would attach company research to a project the actor has no
  part in — and the project dashboard would then count it.
- Related files pass the same two-stage visibility check search uses: folded into the
  query, then re-checked per row. A duplicate-detection panel that reported "this file
  also exists in Analytical Chemistry" would leak a filename and a folder location.
- Dashboard figures are computed over the caller's visible set, so two members of one
  project can legitimately see different totals. A single organization-wide number would
  tell a viewer exactly how much of the project is hidden from them.
- **A metadata template may only arrange fields the codebase declares.** Template field
  keys become MongoDB dotted paths under `File.metadata`; an administrator inventing one
  would reach past the allow-list that exists to stop exactly that. Keys are filtered on
  write *and* on read.
- Template editing is gated on **company-scoped** `access.manage`, not "is an
  administrator": a department head holds `access.manage` for their own department and has
  no business rewriting the template other departments' drives are built from.
- Editing a template never rewrites existing drives — renaming `06_Raw Data` must not
  rename it in forty live projects. The dashboard reports the gap instead.

### Fixed
- Department drives were documented as getting a four-folder template in Phase 3 but no
  code ever applied one. Template application now lives in one place
  (`template.service.applyFolderTemplate`) and both project and department roots build
  from it; department roots apply it on first open, idempotently by name.

### Tests — 315 passing (up from 299)
16 research tests: experiment invisibility across departments (rows *and* total),
read-but-not-edit refusal, company-wide duplicate codes, non-member collaborators,
experiment folders outside the project drive, link-then-trace with file counts, the
cross-project link refusal, duplicate detection by checksum, the duplicate that must not
be reported across a department boundary, sample grouping, a restricted file excluded from
a company-wide reader's dashboard, missing-template reporting, department-scoped template
refusal, template edits applying only to new drives, four rejected metadata field keys
(`$where`, `__proto__`, `a.b`, an invented name), and the surviving `general` template.

## [Phase 8] — 2026-07-30 — Review and approval

### Added
- `Review`: a request pinned to one **version**, carrying that version's checksum. A
  reviewer signs an exact set of bytes, so no later upload can inherit an approval —
  the "which is the latest approved version?" problem the brief opens with.
- Decisions embedded and append-only, each with reviewer, decision, comment, timestamp,
  IP and user agent (§15). A reviewer who changes their mind adds a decision; none is
  ever rewritten.
- Multi-approval requests (`requiredApprovals`); one rejection or change-request closes
  the round immediately rather than collecting the remaining approvals.
- Pending-review dashboard (waiting on me / my submissions), approved-files page, submit
  dialog, and an approval-history section in the file details panel.
- `POST/GET /api/files/[id]/reviews`, `POST /api/reviews/[id]/decision`,
  `DELETE /api/reviews/[id]`, `GET /api/reviews`, `GET /api/approved`.

### Security decisions
- **Self-approval is refused in the service, not left to the permission layer.** A
  scientist who also holds a department approver role would otherwise pass every
  permission check on their own submission — the authorizer has no concept of "but it's
  yours". Both the submitter and the file owner are refused.
- A new version (upload *or* restore) cancels any open review: a pending review of
  superseded bytes would let someone approve content that is no longer current.
- The decision path re-checks the version checksum against the one recorded at
  submission. Signing bytes that are no longer the submitted bytes would produce an
  approval record that means nothing.
- `appendDecision` filters on `status: 'pending'`, so two reviewers deciding at the same
  instant cannot both close a request.

### Tests — 299 passing (up from 286)
13 review tests: version pinning, supersession, duplicate-request refusal, self-approval
refusal (including the escalation case where the owner is injected into the reviewer
list), unnamed-reviewer refusal, approval locking the file, decision evidence captured,
approval reset by a new version with the approved version's record intact, rejection
closing the round, two-of-two approvals, double-decision refusal, dashboard scoping.

## [Phase 7] — 2026-07-30 — Sharing and collaboration

### Added
- Internal sharing for files and folders: grant, revoke, change level, explicit deny,
  expiring grants, and break/restore folder inheritance. Principals are users,
  departments, projects or roles — there is no principal type meaning "everyone", so
  public links are absent by construction rather than merely unimplemented.
- `Comment` with one-level threading, version pinning, resolve/reopen, and `@mentions`.
- `Notification`, one row per recipient, carrying a label and never content.
- Shared-with-me page, share dialog, comment panel, notification bell, and per-file
  view/download history read from the audit log.

### Security decisions
- **You cannot delegate what you do not hold.** A share is refused if the access level's
  permission bundle contains anything the sharer cannot do on that resource themselves —
  checked per permission, because the levels are not one ordered ladder.
- Denies and inheritance changes require `access.manage`, not `share.internal`: they
  remove reach from people not named in the request.
- Breaking inheritance copies the inherited entries down, so nobody silently loses access.
- A mention is not a grant: mentions of people who cannot open the file are dropped, since
  the notification itself would disclose the file's existence.
- Comments have no write path into `File` or `FileVersion`, so they are permitted on
  approved files — discussion is not modification.
- Reading the share list needs `share.internal`, not view: the roster names colleagues.

### Fixed
- `access.manage` was unreachable on personal-drive content. It is excluded from
  `OWNER_PERMISSIONS` for good reason (in a department drive the "owner" is merely the
  uploader), but personal content carries no department or project, so *nobody* could
  administer it. Ownership now confers `access.manage` only when both are absent.

### Tests — 286 passing (up from 272)
14 sharing tests including immediate revocation, the delegation guard, deny beating
inherited allow, inheritance-break preserving access, deactivated-account refusal, share
list privacy, comment/file isolation, reply flattening, and mention gating.

## [Phase 6] — 2026-07-30 — Metadata, versioning and search

### Added
- Research metadata as a **closed allow-list** of 15 declared fields with six form
  templates. `File.metadata` is a Mixed subdocument, so an attacker-chosen key would be
  written verbatim and could later be read as an operator or a dotted path; no code path
  writes a key this codebase did not declare.
- Version restore that **appends rather than rewinds**: the old bytes are copied to a new
  physical key and a new version records where it came from. Nothing is overwritten and
  the approved version stays exactly where it was.
- Cross-drive search over files and folders — free text plus category, confidentiality,
  review/approval status, tags, dates, size and exact-match research metadata — with
  facet chips and saved searches.
- `GET /api/search`, `/api/search/facets`, `/api/search/saved` (+ `[id]`),
  `/api/metadata/templates`, `POST /api/files/[id]/versions/[versionId]/restore`,
  `PATCH .../versions/[versionId]`.

### Security decisions
- Search enforces visibility **twice**: folded into the MongoDB query so restricted rows
  are never fetched and `total` never counts them, then re-checked per row with the same
  `can()` the mutating routes use. The redundancy is the point.
- Facet counts are computed over the caller's visible set — "restricted (4)" is a
  disclosure even when none can be opened.
- Saved searches store criteria, never result ids, so they cannot become a stale window
  onto a file that was later restricted.
- Declassifying a file requires `access.manage`; raising a classification is unrestricted,
  because it only ever removes reach.

### Tests — 272 passing (up from 255)
17 tests: cross-drive search privacy (rows *and* totals), restricted-file exclusion,
sample-ID lookup without knowing the folder, metadata allow-list and type rejection,
annotation clearing, tag dedup, classification rules, and six version-restore invariants
including distinct storage keys and the approved version surviving a restore.

### Fixed
- Database-backed suites were silently **skipping** rather than failing when the in-memory
  MongoDB could not start, and running them in parallel exhausted disk space on a
  developer machine — so six security suites reported "passed" without executing. Test
  files now run sequentially (`fileParallelism: false`).

## [Phase 3] — 2026-07-29 — Core drive and folder management

### Added

**Data model**
- `Folder` with a parent reference *and* a materialized `pathAncestors` array (root → parent),
  which makes breadcrumbs, subtree queries and circular-move detection all cheap. A unique
  partial index on `(parentFolderId, nameLower)` makes two folders with the same name in one
  parent impossible; a unique `rootKey` makes drive-root creation race-safe.
- `Project` (extended in Phase 9), `Star` (per-viewer, never per-resource), `Activity` (the
  user-facing timeline, distinct from the audit log) and `RecentItem` (one upserted row per
  user/item rather than a `$group` over an ever-growing feed).
- Shared embedded ACL sub-schema for folders and files.

**Drives**
- My Drive, department drives and project drives, with roots created on first open.
  Personal-drive folders deliberately carry no department or project, so no role scope reaches
  into them and ownership is the only route in.
- Project drives are generated from the twelve-folder research template; department drives get
  a lighter four-folder template.

**Folder operations**
- Create, rename, update, move, copy, archive/unarchive, trash and restore — each of them
  permission-checked against the folder's whole ancestor chain, audited, and mirrored into the
  activity feed.
- Move rewrites the entire subtree in two statements using an update pipeline, inside a
  transaction. Copy is breadth-first and deliberately does **not** carry the source's ACL, so
  copying can never smuggle a share into a place it was never granted.
- Trash sweeps the subtree and records `trashedWithFolderId`, so restoring a parent restores
  exactly what went down with it and not folders trashed separately beforehand.
- `purge-trash` script for the retention window (an explicit, auditable job, not a TTL index).

**Permissions**
- `childVisibilityFilter`: expresses "children of a folder you may already open" as a query —
  explicit denies, broken inheritance and the confidentiality gate — so `total` never counts
  rows the viewer cannot see.
- `OWNER_PERMISSIONS` extended with `folder.create`, `file.upload`, `resource.move` and
  `resource.copy`: without them a personal drive would be read-only to its own owner.
- `folder-access.ts` loads the ancestor chain once per request so no route can forget it.

**API** — `/api/drives`, `/api/drives/my`, `/api/drives/departments/[id]`,
`/api/drives/projects/[id]`, `/api/folders` (+ `[folderId]`, `/children`, `/rename`, `/move`,
`/copy`, `/restore`, `/archive`, `/star`, `/activity`), `/api/trash`, `/api/archive`,
`/api/starred`, `/api/recent`, `/api/projects` (+ `[projectId]`).

**UI** — drive browser with list and grid views, breadcrumbs with middle-collapse, sort,
in-folder filter, pagination, per-row actions menu, destination picker that disables the
moving folder's own subtree, details panel with the activity timeline, and Recent, Starred,
Trash and Archive pages. Empty, loading, error and permission-denied states throughout;
toasts for operations that are otherwise silent.

### Fixed
- `applySoftDeleteFilter` was defined in Phase 1 but never applied to a schema, so trashed
  records would still have appeared in ordinary queries. Applied to `Folder`. Caught by the
  trash/restore test.
- `Folder` declared a second index on `deletedAt`, colliding with the one `softDeleteFields`
  already creates — which made `syncIndexes()` throw and silently skipped the whole database
  test suite.
- `sanitizeDisplayName` removed tab and newline outright, running words together
  ("Line\nbreak" → "Linebreak"); whitespace controls now collapse to a space.

### Tests — 206 passing (up from 178)
- 15 folder/drive security tests: personal-drive privacy from a department head, cross-department
  refusal, case-insensitive name collision, root immutability, self- and descendant-move
  refusal, subtree `pathAncestors` rewrite verified against the breadcrumb, trash/restore
  fidelity, orphan-restore refusal, copy dropping the source ACL, and star privacy.
- 13 naming tests, including the U+202E filename-disguise case and path-separator rejection.

### Verified in a running server
Login → `/api/drives` lists My Drive and three department drives → create nested folders →
circular move rejected with `CIRCULAR_MOVE` → duplicate name rejected with `CONFLICT` →
missing CSRF header rejected with 401 → trash reports 2 affected and lists only the parent →
restore → department drive shows its four template folders → star appears in `/api/starred`.

## [Phase 1] — 2026-07-28 — Project foundation

### Added

**Application**
- Next.js 15 App Router project (TypeScript strict, `noUncheckedIndexedAccess`), Tailwind CSS,
  shadcn-style UI primitives (button, card, badge, skeleton, separator, sheet, dropdown-menu,
  input, tooltip), light/dark/system theming, TanStack Query provider.
- Application shell: header with mobile navigation sheet, sidebar with per-phase availability
  markers and a storage meter, skip-to-content link, responsive layout.
- Home page with a live system-status card (database + storage), rendering loading, error and
  populated states.
- Error boundaries (`error.tsx`, `global-error.tsx`), `not-found.tsx`, route-level `loading.tsx`.

**Server core**
- Fail-fast environment validation (Zod) with derived byte limits, resolved storage roots, and a
  boot assertion that refuses any storage root inside a publicly served directory.
- Typed `AppError` hierarchy and a uniform API envelope; unknown errors never leak internals.
- `withRouteHandler` wrapper: request-id propagation, structured logging, error mapping.
- Pino logging with redaction of secrets, tokens and physical paths.
- MongoDB connection with hot-reload-safe pooling, `sanitizeFilter`, health check, and a
  `withTransaction` helper (single-node replica set supported).
- Base schema conventions: timestamps, soft-delete fields and default filter, `toJSON` transform
  that strips `_id`, `__v`, password hashes, session hashes and storage keys.
- Models: `Organization`, `AppSetting`, plus a model registry.

**Storage**
- `StorageProvider` interface and `LocalStorageProvider`: streaming writes with in-flight
  SHA-256 and byte counting, exclusive-create (no overwrite), fsync of file and parent directory,
  ranged reads, atomic move, copy, delete, directory removal, chunked write handles, capacity.
- Path safety: allow-list key validation, resolved-prefix containment, filename sanitization
  (traversal, control characters, bidi overrides, Windows reserved names, 255-byte truncation),
  RFC 5987 `Content-Disposition` builder with header-injection protection.
- Storage key builders for originals, versions, previews, quarantine, chunks, migration staging,
  exports and archives.

**Operations**
- `GET /api/health` (liveness), `GET /api/health/ready` (database + storage round-trip probe +
  disk headroom, 503 when unhealthy), `GET /api/version`.
- `server/bootstrap.ts`: memoized one-time configuration validation and storage-tree
  preparation, invoked from the authenticated layout.
- Multi-stage Dockerfile (standalone output, non-root, tini, healthcheck), Docker Compose base +
  dev + prod overrides, persistent `app-data` / `mongo-data` volumes, replica-set init container,
  nginx dev and prod configs (streaming uploads, rate-limit zones, no route to `/data`),
  encrypted backup job script.
- Scripts: `check-env`, `init-storage`, `verify-storage-integrity`.
- `.env.example` covering every documented variable.

**Tests** — 86 passing (83 unit, 3 integration)
- Path safety: 36 tests including nine traversal payloads and header-injection prevention.
- Local storage provider: 20 tests covering no-overwrite, truncation, oversize abort, stream
  failure cleanup, ranged reads, move/copy semantics, chunked writes, and a 32 MB streaming test
  asserting memory stays well below payload size.
- Environment validation: 10 tests including the public-directory refusal.
- Storage keys, error mapping, and three architectural-boundary tests.
- MongoDB integration: connection health, transaction commit **and rollback**, index enforcement,
  and serialization hygiene (uses `mongodb-memory-server` with a replica set; skips loudly if the
  binary cannot be provisioned).

### Fixed
- `saveFile` deleted the pre-existing file when an exclusive create failed with `EEXIST`, which
  would have destroyed a stored version on a key collision. It now leaves the existing file
  untouched. Caught by the "refuses to overwrite an existing key" test.
- `next.config.ts` emitted an empty `headers` array outside production, which Next rejects at
  startup ("Invalid header found").
- Server modules now import Node builtins with bare specifiers (`path`, not `node:path`): the
  `node:` scheme fails to resolve in this Next version's dev-mode webpack compilation.
- Replaced the `instrumentation.ts` hook with `server/bootstrap.ts`. Next compiles
  `instrumentation.ts` for the edge runtime as well, where `fs` and `path` do not resolve.

### Verified in a running server
`npm run dev` → `/api/health` 200, `/api/version` 200, `/api/health/ready` 200 with
`database: ok` and `storage: {writable: true}`; `/home` renders the shell and status card;
security headers present on every response; `/data/...`, `/uploads/...`, `/storage/...` all 404;
the storage tree (`originals`, `versions`, `previews`, `quarantine`, `temporary`,
`migration-staging`, `exports`, `archives`) is created outside `public/`.

### Notes
- Docker is not installed on the development machine used for this phase, so the Compose stack was
  authored and reviewed but not executed. The persistence acceptance criterion is verified by the
  storage tests and by the volume configuration; a container-restart test runs in Phase 4.

## [Phase 0] — 2026-07-28 — Requirements & architecture

### Added
- Complete Phase 0 deliverable in `docs/phase-0/`: requirements and scope, system architecture,
  24-collection data model with the full indexing plan, storage design and provider abstraction,
  authentication flows and the role × permission matrix, upload/preview/download/versioning
  sequences, API endpoint surface, STRIDE threat model with 18 abuse cases, deployment and backup
  architecture, Google Drive migration strategy, UI structure, and the testing and phase plan.
