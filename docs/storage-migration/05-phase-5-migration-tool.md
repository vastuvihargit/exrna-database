# Phase 5 — The migration tool

Status: **complete and tested**, against an in-memory Drive. Never run against a real
Google account.

Assumes a **single Shared Drive** (agreed with the customer). Sharding across several drives
would change `GOOGLE_SHARED_DRIVE_ID` from a scalar into a per-department mapping; the item
projection below is what tells you when that becomes necessary.

---

## 1. Running a migration

Always in this order. Small first.

1. **Create a dry-run job** over one folder. `/admin/storage-migration` → New job → leave
   "Dry run" ticked.
2. **Check what would move.** The report has to be clean on both external ceilings before
   anything else happens — see §4.
3. **Create the same job in migrate mode**, and run it. A run is bounded (200 items per
   request), so press it again to continue. That is not a limitation to work around: it is
   what keeps a request inside the 300-second platform ceiling.
4. **Re-check moved files** once it completes. Metadata only, no bytes.
5. Leave it. Local copies are retained for `LOCAL_COPY_RETENTION_DAYS` (default 30) and
   deleting them is Phase 11, gated on a tested restore drill.

Rolling back at any point is one button and moves no data.

---

## 2. The transfer, step by step

```
claim item atomically (status + claimActive, guarded by a unique index)
   ↓ already in Drive and verifies?          → skip
   ↓ hash local file: SHA-256 + MD5, one pass
   ↓ SHA-256 ≠ database?                     → LOCAL_CORRUPT, nothing uploaded
   ↓ ensureDriveFolderPath(folder), root → leaf, lazy
   ↓ open recovery row                       ← BEFORE any Drive write
   ↓ search Drive for an orphan by idempotency key; adopt if found
   ↓ resumable upload; MD5 verified against Drive's own md5Checksum
   ↓ mismatch?                               → delete remote object, VERIFY_MISMATCH
   ↓ commit FileVersion; close recovery row
   ↓ LOCAL COPY UNTOUCHED
```

The **ordering rule** is the whole design: the recovery row is written before the Drive call
and cleared after the MongoDB commit, so anything still open is by construction an operation
that got part-way.

---

## 3. Why retries cannot duplicate

Four independent layers. Independent because each covers something the others cannot see.

| Layer | Mechanism | Covers |
|---|---|---|
| 1 | Atomic claim (`findOneAndUpdate`, status in the filter) | Two workers, or a restart alongside a live run |
| 2 | Unique partial index on `FileVersion.googleDriveFileId` | Everything else having failed — **this is the layer still working when the worker has crashed** |
| 3 | Pre-flight `files.get` on a recorded Drive id | A retry after a lost response |
| 4 | `appProperties.idempotencyKey` + the recovery row | The process dying between the Drive commit and the database commit |

Layer 4 is the one worth understanding. After that crash, *nothing in the database points at
the object*. The recovery row says which key to search Drive for; without it the retry
uploads again and company storage accumulates an orphan per crash.

There is a test for each layer, including one that rewinds the database while leaving the
Drive object — exactly what that crash produces — and asserts no second object is created.

---

## 4. The two ceilings a plan reports

Both are external, hard, and cannot be raised by anyone.

**R1 — Shared Drive item limit: 500,000.** Every file *version* and every mirrored *folder*
is an item. The plan reports `projectedItems` and warns above 350,000. Past that, a single
Shared Drive is no longer viable and the design needs sharding — cheap to plan now, very
expensive to retrofit.

**R2 — folder depth: Drive allows 20, this application allows 32.** A dry run lists every
folder too deep to represent, by name and depth. Flatten those trees *before* migrating;
they otherwise appear as a run of `FOLDER_TOO_DEEP` failures part way through.

---

## 5. Failure codes

Grouped and counted on the dashboard, and translated there into something actionable.

| Code | Meaning | What to do |
|---|---|---|
| `LOCAL_MISSING` | The file is not on this server | Investigate; it may already have been purged |
| `LOCAL_CORRUPT` | On-disk bytes no longer match the recorded checksum | **Do not retry blindly.** This is local bit-rot; restore from backup |
| `VERIFY_MISMATCH` | What arrived in Drive did not match what was sent | Retry — the remote copy was already deleted |
| `FOLDER_TOO_DEEP` | Deeper than Drive's 20 levels | Flatten the tree, then retry |
| `FOLDER_MAPPING_FAILED` | The destination folder could not be created | Check the Drive connection |
| `DRIVE_QUOTA_EXCEEDED` | The Shared Drive is full | Free space or add a drive |
| `DRIVE_PERMISSION_DENIED` | Service account cannot write there | Check its Shared Drive membership |
| `DRIVE_RATE_LIMITED` | Google asked us to slow down | The job pauses itself; retry later |
| `DATABASE_WRITE_FAILED` | Bytes reached Drive, the record did not | Retry — it will adopt, not re-upload |

A `429` or a quota failure stands the **whole job** down for a cooldown rather than retrying
tightly. Drive's quota is shared with every interactive upload and download; employees win.

---

## 6. Rollback

**A field flip. No data moves and nothing is deleted.**

- `storageProvider` → `local`, `migrationStatus` → `rolled_back`.
- The Drive object is **left in place** — deleting it would make the rollback itself the
  destructive act. Clean it up deliberately later, once the reason is understood.
- A version whose local copy has already been deleted is **skipped, not flipped**. Pointing
  a record at bytes that are not there converts a recoverable situation into data loss. The
  audit entry for a rollback with skips is `critical`.

This only works while local copies exist, which is why `DELETE_LOCAL_AFTER_MIGRATION`
defaults to false.

---

## 7. Acceptance criteria

| Criterion | Evidence |
|---|---|
| A test project migrates without data loss | 3 files uploaded through the real pipeline, migrated, each re-downloaded byte-identical |
| Duplicate retries do not duplicate Drive files | Layer-3 and layer-4 tests; object count asserted unchanged |
| Killing the worker mid-transfer produces no duplicate | Database rewound with the Drive object left in place; second run adopts it |
| Failed files remain local | Record untouched after an injected failure, and the file still downloads |
| Verified files open from Drive | Read through the ordinary download path, not a test hook |
| Metadata and approvals remain intact | Tags, `approvalStatus`, `approvedVersionId`, `isApproved` and the checksum all asserted after the move |
| L1 rollback executed, every file re-downloaded | A test, not a promise |
| Item count projected and recorded (R1) | Reported on every plan |
| No folder deeper than 19 in the migrated set (R2) | Reported on every plan, by name |

---

## 8. Before Phase 10 (production migration)

1. **Complete Phase 2's manual checklist against a real Shared Drive.** Nothing in Phases
   2–5 has touched a real Google account. That is the single largest untested surface.
2. **Run a dry run over production** and read both ceilings.
3. **Rehearse a rollback** on a small real project, not just in tests.
4. Migrate in the order §20 of the brief specifies: internal test folder → test department →
   small project → selected active projects → the rest → archive.

Until Phase 9 sync exists, keep Shared Drive membership to the service account plus two
named administrators. A file renamed in the Drive web UI silently diverges from what the
application believes.
