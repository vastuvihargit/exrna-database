# Phase 11 — Cleanup

The last step, and the only irreversible one in the whole migration.

---

## 1. What is actually being cleaned up

Every version migrated to Drive keeps its local bytes. That retention has been load-bearing
since Phase 5, in two separate ways:

- **Rollback is a field flip.** Reverting a version to local storage moves no data and deletes
  nothing — it works precisely because the bytes never left. §8 of the Phase 0 analysis rests
  entirely on this.
- **Phase 4 falls back to it.** When a Drive object goes missing, `stored-content.ts` serves
  the retained local copy rather than failing. An employee keeps working through somebody else
  emptying the Shared Drive trash.

Removing local copies ends both guarantees. So this phase is not "tidying up" — it is the
deliberate surrender of the migration's safety net, and everything about its design is shaped
by making that a decision rather than a default.

---

## 2. Archive and delete are two different actions

This is the central design decision of the phase, and it exists because "reclaim the disk" and
"give up the ability to undo" are two different wishes that a single delete action would
conflate.

| | **Archive** | **Delete** |
|---|---|---|
| What happens to the bytes | Moved from `originals` into `archives` | Removed |
| Rollback still possible | **Yes** — restored from the archive first | No |
| Phase 4 fallback still possible | Not automatically, but the bytes exist | No |
| Disk reclaimed | All of it, as far as the originals tree is concerned | The rest |
| Gated on `DELETE_LOCAL_AFTER_MIGRATION` | No | **Yes** |
| Live Drive existence check | No | **Yes** |
| Reversible | Yes | **No** |

**Archive is the one to reach for.** It returns the space while keeping every property that
matters. Delete exists because eventually somebody will want the archive tree gone too, and it
should be an explicit act with its own audit entry rather than a quiet consequence of a
retention timer.

### Why `storageKey` is not rewritten

Archiving does not change `storageKey` or `storageArea` — both are in
`IMMUTABLE_VERSION_PATHS` and must stay there. They record the address the version was
*created* at, which is what the checksum and the approval refer to; a migration able to rewrite
them could hide a bad transfer by recording the wrong address as expected.

So the archive location goes in a new field, `archivedStorageKey`, which says "the bytes are
still here, just moved aside". That is what makes an archived copy something rollback can
restore from.

---

## 3. Five conditions, all required

A local copy is eligible only when **all** of these hold. None is inferred from another.

1. `storageProvider: 'google_drive'` — it actually migrated.
2. `migrationStatus: 'verified'` — not merely `uploaded`. Bytes reaching Drive is not the same
   event as those bytes being proved correct, and only the second may authorise touching the
   original. That distinction is why the two statuses exist.
3. `localCopyEligibleForDeletionAt` has passed — `LOCAL_COPY_RETENTION_DAYS`, default 30.
4. `localCopyState` is a state that has bytes.
5. **For deletion only:** the Drive object answers a live existence check *at that moment*.

Condition 5 is the important one. `verified` was set by a job, possibly weeks ago, and nobody
has re-checked it since. If somebody has emptied the Shared Drive trash in the meantime,
deleting the only other copy on the strength of a stale flag is precisely the data-loss event
this whole design exists to prevent. A file that fails this check is skipped, counted, and the
reason is reported.

---

## 4. How it is driven

```http
GET  /api/admin/storage/local-copies
POST /api/admin/storage/local-copies   { action: "archive" | "delete", limit?, dryRun? }
```

`dryRun` **defaults to true** — the only endpoint in this application whose safe mode is the
default. A mistyped request here removes the last copy of somebody's data, and an extra round
trip costs nothing against that.

**There is deliberately no cron script.** §18 of the brief says archival and deletion happen
"only after explicit admin approval", and a scheduled job is the precise opposite of that.
`drive:drain`, `drive:sync` and `drive:check-approvals` are all scheduled because all three are
safe to run unattended; this is not, and it is the one place in the migration where the absence
of automation is the feature.

The admin System page shows **"Local copies kept after migration"** — how much disk they hold
and how much is now past its retention window. Always `ok`, never a warning: those files are
doing exactly what they were kept for, and flagging them would invite somebody to clear them
for the sake of a green tick. Disk pressure has its own check, and that is the one that should
prompt action.

---

## 5. The order of operations, and why

**Archiving** copies to the archive, updates the record, *then* removes the original. A crash
in between leaves two copies and a record pointing at the original — harmless, and the next run
tidies it. The reverse order would leave a window in which neither copy is referenced.

**Deleting** checks Drive, removes the bytes, then records `deleted`. Removal is idempotent, so
an already-missing object is not an error — but the record still has to be brought in line with
reality, because `localCopyState` is what rollback consults before refusing.

---

## 6. The other Phase 11 items

**Obsolete direct filesystem calls — none remain.** Verified rather than done: no file outside
`src/server/storage/` imports `node:fs` at all. Phase 1's abstraction was thorough enough that
there was nothing left to remove, which is the outcome that phase was aiming for.

**`LocalStorageProvider` stays.** It is not legacy. It backs every pre-migration file, every
upload's quarantine and verification stage (decision D1 — bytes are scanned locally before they
ever reach Drive), every retained copy, and every rollback. A deployment can also run entirely
on it, which remains a supported configuration.

**Unused environment variables — none removed.** Every Drive variable is still read. The
inbound importer's `GOOGLE_DRIVE_REDIRECT_URI` is a *different feature* pointing the other way
(§3 of the Phase 0 analysis) and is not obsolete.

**Backup strategy.** Once local copies are archived or deleted, the local originals tree stops
being a complete copy of the corpus and the backup story changes shape:

- MongoDB remains the single most important thing to back up, and more so than before — it now
  holds the only mapping between an application file and its Drive object.
- The Shared Drive is Google's responsibility for durability, but *not* for accidental deletion
  by a person. Drive's trash is 30 days.
- If a second independent copy of the binaries is a compliance requirement, archiving rather
  than deleting is how this application provides it — and the archive tree then belongs in the
  backup rotation.

`docs/operations/backup-and-restore.md` should be updated with whichever of those the
organization decides on. That decision has not been made here because it is a policy question,
not a technical one.

---

## 7. Acceptance criteria

| Criterion (brief, Phase 11) | Status |
|---|---|
| Archive local files | Done. `archive` action, `archives` area, `archivedStorageKey` |
| Remove obsolete direct filesystem calls | None exist — verified by search |
| Keep `LocalStorageProvider` for rollback or future use | Kept, and still load-bearing in four separate paths |
| Update documentation | This file, the Phase 10 runbook, `.env.example` |
| Update backup strategy | Consequences documented above; the policy decision is the organization's |
| Remove unused environment variables only after verification | None are unused |
| **Do not delete local files automatically** | No scheduler, no side effects, `dryRun` defaults true, deletion additionally gated on `DELETE_LOCAL_AFTER_MIGRATION` and a live Drive check |

**Nothing has been archived or deleted in production**, because nothing has been migrated in
production. This phase is complete as a mechanism, tested end to end against the in-memory
Drive; it becomes complete as an *operation* only after Phase 10 has actually been carried out
and the verification period has passed.
