# Phase 6 — New uploads to Google Drive

Status: **complete and tested**, against an in-memory Drive. Never run against a real
Google account.

Setting `DEFAULT_STORAGE_PROVIDER=google_drive` now means new uploads end up in the Shared
Drive. The upload tray is **unmodified**.

---

## 1. The central decision: an upload never waits for Google

```
quarantine → size/checksum → signature → malware scan → move to originals (local)
   → commit MongoDB record          ← the file exists, works, and is downloadable from here
   → small file & Drive healthy?    transfer inline
   → otherwise                      migrationStatus: 'queued'
   → return Complete
```

The file is complete and readable **before** Drive is involved at all. That is the same
state every pre-migration file is in, which the whole of Phase 4 exists to serve — so
handing it to Drive afterwards is a step that can fail, retry or wait out an outage without
anybody's upload failing.

### Deviation from decision D6, and why

Phase 0's D6 specified a `saving` status: finalize would return early above ~100 MB and the
file would not exist until a background transfer completed it. The reasoning — that finalize
would otherwise block for the whole server→Drive transfer — was correct when written.

Phases 3–5 made a better option available. Rather than adding a state for the user to wait
in, the transfer simply does not happen inside the request. There is no `saving` state
because there is no window in which the employee's file does not exist.

| | D6 as written | What shipped |
|---|---|---|
| Drive is down | uploads fail | uploads succeed; a queue forms |
| Transfer fails | upload reported failed | file is fine, retried later |
| Large file | user waits in `saving` | file usable immediately |
| New UI states | tray gains `Saving` | none |

**The cost:** during a Drive outage local disk holds pending files for longer. Visible on
the admin System page, and it is the same disk those files occupy for
`LOCAL_COPY_RETENTION_DAYS` anyway.

If you want the D6 shape instead, it is a contained change to `handOffToDrive` plus a status
on `UploadSession` — say so and it can be swapped.

---

## 2. Bytes reach Drive from `originals`, never from quarantine

Decision D1, unchanged and now load-bearing in a second place.

The signature check and the malware scan both read the content back before it is trusted.
Uploading from quarantine would put an unscanned file at a real Drive id — visible in the
Drive web UI, syncable to desktops, indexable — for the duration of the scan.

---

## 3. It is the same transfer as a migration

`transferItem` was split into `transferVersion` (the work) and the migration-item
bookkeeping around it. An uploaded file therefore reaches Drive through exactly the code a
migrated one does: same checksum verification, same four duplicate-prevention layers, same
recovery-row ordering.

The consequence is asserted directly by a test: **a newly uploaded file is indistinguishable
from a migrated one.** Same `localCopyState: 'present'`, same `localCopyEligibleForDeletionAt`,
same retained `storageKey`, same `syncStatus: 'synced'`.

That matters because otherwise Phase 4's missing-object fallback and Phase 5's rollback
would apply to only half the corpus.

---

## 4. Operating it

```bash
npm run drive:drain              # from cron, every few minutes
npm run drive:drain -- --limit 100
```

Also `POST /api/admin/storage-migration/drain` (company-scoped `access.manage`), so an
administrator can clear a backlog immediately after fixing a connection.

Safe to run concurrently with itself and with a migration job. Safe to run while Drive is
down: it fails every item, changes nothing, and tries again. **It can never make a file
worse** — every queued version is already complete and readable locally, so the only
outcomes are "also in Drive now" and "still just here".

### Watching the queue

The admin System page shows **Files waiting for the Shared Drive**.

- `n/a` — new uploads are not configured for Drive.
- `0` — everything has arrived.
- a small number — normal; large uploads are always queued and clear themselves.
- **50+ → warning** — a backlog that is not draining, which usually means Drive has been
  unreachable. Never critical: nothing is broken for anybody using the application.

---

## 5. Configuration

```env
DEFAULT_STORAGE_PROVIDER=google_drive   # the switch that turns this on
UPLOAD_DRIVE_SYNC_THRESHOLD_MB=100      # above this, queue instead of transferring inline
```

Having Drive **connected** is not the same as having new uploads **go** there. A deployment
mid-migration is in exactly that state — `GOOGLE_DRIVE_STORAGE_ENABLED=true` with
`DEFAULT_STORAGE_PROVIDER=local` — and keeps writing locally until switched over. A test
asserts it touches Drive not at all in that configuration.

---

## 6. Acceptance criteria

| Criterion | Evidence |
|---|---|
| New uploads appear in Drive and MongoDB | Round trip asserted byte-identical through the ordinary download path |
| Upload tray remains functional | **`upload-tray.tsx` unmodified** — no client change in this phase |
| Large files use resumable upload | Phase 2's resumable client, unchanged; every transfer uses it |
| Failed uploads are recoverable | Queued and retried by the drain; 503 and 403 both tested |
| Existing local files remain accessible | Full suite passes; live round trip with Drive off unchanged |

**Not met as written:** "a 1 GB upload completes with server RSS growth under 100 MB". The
memory property holds by construction — quarantine writes stream, the resumable uploader is
bounded to one 16 MB chunk, and a test in `drive-resumable-upload.test.ts` asserts the chunk
ceiling — but no actual 1 GB upload has been run and measured. That needs a real
environment, alongside the real-Drive checklist.

---

## 7. Before switching a production deployment over

1. Complete Phase 2's manual checklist against a real Shared Drive. **Still the largest
   untested surface in this project.**
2. Set up `npm run drive:drain` on a schedule *before* setting
   `DEFAULT_STORAGE_PROVIDER=google_drive` — otherwise large uploads queue with nothing to
   drain them.
3. Measure a large upload's memory, per the criterion above.
4. Flip `DEFAULT_STORAGE_PROVIDER` and watch the queue on the System page for a day.

Reverting is `DEFAULT_STORAGE_PROVIDER=local` and a restart. Files already in Drive keep
being served from Drive; new ones go local again. Nothing is stranded either way.
