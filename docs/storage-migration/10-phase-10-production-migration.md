# Phase 10 — Production migration

This phase adds no code. Everything it needs was built in Phases 1–9; what it adds is the
order in which to use it, and the points at which to stop.

That is not a gap. A migration tool that is safe only when driven in a particular order is a
tool with an undocumented dependency, and this document is that dependency written down.

---

## 0. Before anything moves

**These are prerequisites, not suggestions. Each one is here because skipping it makes a later
step irreversible.**

| | Why |
|---|---|
| Phase 2's manual checklist run against the **real** Shared Drive | Everything in Phases 2–9 is tested against an in-memory fake. The fake models the API faithfully — including the awkward parts, like native documents having no `headRevisionId` — but it has never been wrong in the way a real service is wrong. **This is still the largest untested surface in the project.** |
| A database backup, verified by a restore drill | The migration writes to `filesversions` continuously. Rollback covers a migration going wrong; it does not cover the database going wrong |
| `DELETE_LOCAL_AFTER_MIGRATION=false` | The default. Confirm it rather than assume it — every rollback in this plan depends on the local copies still being there |
| `npm run drive:drain` scheduled | Only needed once new uploads go to Drive, but scheduling it late means large uploads queue with nothing to drain them |
| `npm run drive:sync` scheduled | Otherwise nothing notices changes made directly in the Shared Drive |
| `npm run drive:check-approvals` scheduled | Otherwise an approved document edited in Drive keeps its badge until somebody happens to look |
| The Drive API quota checked against the corpus size | One request per version, plus retries. A 200,000-file corpus is not a rounding error against a daily quota |

Also read `docs/storage-migration/00-phase-0-analysis.md` §5.7 and §8 once more. The rollback
story is a field flip **only while local copies exist**, and every decision below follows from
that.

---

## 1. The controlled groups

The brief names six, and they are in this order for a reason: each one buys information the
next one needs, and the first three are cheap to abandon.

| # | Group | What it proves | If it fails |
|---|---|---|---|
| 1 | An internal test folder | The Drive connection, folder mirroring, checksum verification and the round trip work *here*, against real Google | Stop. Nothing has moved but test data |
| 2 | One test department | Folder mirroring at depth; permissions unchanged; the department's people can still work | Roll back the job. One department is briefly slower |
| 3 | One small, finished project | An entire coherent unit, including approvals and version history | Roll back. Nothing was in flight |
| 4 | Selected active projects | Migration under load, with people using the files while it runs | Roll back the affected job only |
| 5 | Remaining active files | Scale | Roll back per job — which is why this is several jobs, not one |
| 6 | Archive files | Bulk, no urgency | Retry at leisure |

**Do not migrate everything in one job.** Not because the runner cannot handle it, but because
a job is the unit of rollback. One job over the whole corpus means the only available undo is
"undo everything", and it will be needed at exactly the moment that is least acceptable.

Practical sizing: keep a job under about 20,000 versions. Split group 5 by department or by
date range using the selection filters.

---

## 2. The sequence for every single group

The same five steps, every time. Steps 2 and 5 are the ones people skip when a migration is
going well, and they are the ones that make the next failure survivable.

### 1. Plan — a dry run that writes nothing

```http
POST /api/admin/storage-migration            { name, mode: "dry_run", selection }
POST /api/admin/storage-migration/{id}/plan
```

Read the plan report before running anything. It answers four questions:

- **`selected` / `selectedBytes`** — is this the set you meant? A selection that quietly
  matched 400,000 versions instead of 400 is visible here and nowhere later.
- **`alreadyMigrated`** — counted, never transferred again.
- **`tooDeep`** — folders nested deeper than Drive can represent. These need moving *before*
  the migration, not during it.
- **`itemProjection`** — what the Shared Drive would hold afterwards, against its item limit.
  A Shared Drive that hits its ceiling mid-migration fails every remaining transfer.

### 2. Take a database snapshot

Immediately before the run, not this morning. The snapshot is what covers the case rollback
does not: the metadata being wrong rather than the storage.

### 3. Run

```http
POST /api/admin/storage-migration/{id}/run
```

Watch on `/admin/storage-migration`: completed, verified, failed, remaining, current rate,
failure reasons. Pause at any point — `POST .../pause` — and resume by running again. The
runner claims items individually, so a pause never leaves a version half-transferred.

**Failed items stay local and stay readable.** That is the design's central promise and it is
worth re-reading during a run that is going badly: a failure is a file that did not move, not
a file that broke.

### 4. Verify

```http
POST /api/admin/storage-migration/{id}/verify
```

Re-checks each transferred object against Drive. Do this even when the run reported everything
verified — the run's verification and this one are the same check at two different times, and
the gap between them is where a Shared Drive trash-emptying lives.

### 5. Let people use it, then decide

Give the group a working week before starting the next one. What you are watching for:

- Downloads and previews working normally, from Drive.
- The admin System page: **Files waiting for the Shared Drive**, **Shared Drive
  synchronization**, **Approved documents that changed**.
- No rise in support requests about files being slow or missing.

Only then move to the next group.

---

## 3. Rolling back

```http
POST /api/admin/storage-migration/{id}/rollback
```

A field flip. Each version goes back to reading from its local copy; **no data moves and
nothing is deleted**. The Drive objects are deliberately left in place, because deleting them
would make the rollback itself the destructive act — clean them up later, once the reason for
rolling back is understood.

Two things it will refuse:

- A version whose local copy has been **deleted** (Phase 11). There is nothing to roll back
  to, and flipping the record would point it at bytes that are not there. Skipped and counted.
- A version whose local copy has been **archived** but cannot be restored from the archive.
  An archived copy is normally restored automatically as part of the rollback.

**Rehearse this on group 1.** Roll it back deliberately, confirm the files still open, then
migrate it again. A rollback path that has never been executed is a hypothesis, and finding
out during group 5 is not the time.

---

## 4. When to switch new uploads over

Not at the start, and not at the end.

`DEFAULT_STORAGE_PROVIDER=google_drive` decides where *new* content is written and is
independent of anything migrated. The sensible point is after group 3: the connection is
proven under real use, but most of the corpus has not moved yet, so if something is wrong the
population of affected files is small and growing slowly.

Before flipping it, have `npm run drive:drain` already scheduled. Reverting is
`DEFAULT_STORAGE_PROVIDER=local` and a restart; files already in Drive keep being served from
Drive, and new ones go local again. Nothing is stranded either way.

---

## 5. What to do when something goes wrong

| Symptom | What it means | What to do |
|---|---|---|
| A run reports failures | Those versions did not move. They are local, readable, unchanged | `POST .../retry`. Read `failureReason` first — a repeated 403 is a permission problem, not a transient one |
| **Files waiting for the Shared Drive** climbing | Drive has been unreachable for a while. Uploads are succeeding and files are readable; local disk is filling | Fix the connection, then `POST /api/admin/storage-migration/drain` |
| **Approved documents that changed** non-zero | Somebody edited an approved document in Drive. It has gone back to review and its owner has been told | A person decides. Re-review, or restore the document in Drive |
| **Shared Drive synchronization: never run / stalled** | Changes made directly in Drive are not being picked up | Schedule or fix `npm run drive:sync` |
| A conflict on a file | Usually: moved to a different folder in Drive. Not applied here, because this application's folder decides who may see it | Move it back in Drive, or move it here through the application |
| A file reported missing from Drive | The object is gone. The record, its history and (if migrated) its retained local copy all survive | Restore it from the Drive trash, or roll that version back to local |
| Verification fails on a file | Its Drive copy does not match. It has not been trusted | Retry it. The local copy remains authoritative |

---

## 6. Acceptance criteria

| Criterion (brief, Phase 10) | How it is met |
|---|---|
| Every batch has a report | Plan report before, job counters during, verify report after. All retained on the job record |
| Failed items remain accessible locally | Structural: a failed transfer never changes `storageProvider`, so the record still reads from local |
| Local backups exist | Step 0 and step 2 above; `LOCAL_COPY_RETENTION_DAYS` keeps the migrated copies as well |
| Rollback is tested | Step 3: rehearsed deliberately on group 1 before group 2 begins |
| Employees can continue working | Nothing in a migration takes a file offline. A version reads from wherever its own record says, throughout |

**This document is a plan, not a record.** No group has been migrated — there is no production
deployment and no real Shared Drive yet. Phase 10 is complete in the sense that the sequence,
the sizing, the stopping points and the failure responses are decided and written down; it is
not complete in the sense of having been carried out, and it cannot be until the Phase 2
checklist has been run against real Google infrastructure.
