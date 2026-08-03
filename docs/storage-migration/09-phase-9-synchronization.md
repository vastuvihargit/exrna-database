# Phase 9 — Incremental synchronization

Phases 5–8 assume this application is the only thing that touches the Shared Drive. It is
not. A Shared Drive is a real Shared Drive: people open it in the Drive web UI, rename things,
drag them about, and empty the trash. This phase is what notices.

---

## 1. The policy, stated once

**Drive is authoritative for content. This application is authoritative for structure.**

That is not a compromise between two half-measures — it is the only reading consistent with
the brief. §8 says the MongoDB hierarchy *remains* the application hierarchy and Drive should
mirror it. §13 says this application's permission model decides what an employee may do. And
in this codebase a file's folder chain **is** its permission chain and its quota owner.

| Change in Drive | What happens here | Why |
|---|---|---|
| New revision of a file | **Adopted.** Storage metadata updated; if the version was approved, the approval is re-checked immediately | Drive holds the bytes. It is the only thing that knows they changed |
| Renamed | **Adopted** | A name is a label. No permission or quota consequence — and refusing would leave the application showing a name nobody can find in Drive |
| File trashed / restored | **Adopted** | Recoverable in both systems, and again no permission consequence |
| **Moved** | **Reported, not applied** | A move changes who can see the file and which department is charged for it |
| **Folder renamed, trashed or moved** | **Reported, not applied** | The same, multiplied by a whole subtree. A folder rename would also have to be refused on a sibling collision anyway |
| Removed from Drive entirely | Storage state marked missing. **The record is never deleted** | §16, explicitly |
| Anything unrecognised | Counted as unmanaged, otherwise untouched | Somebody else's file in the same drive is not ours to act on |

### Why moves are refused rather than applied

This is the decision most likely to be questioned, so it is worth being direct about it.

Applying a Drive move would mean: somebody drags a file in the Drive web UI — possibly
somebody with no account in this application at all — and this application silently changes
who may read that file, because the destination folder's ACL now governs it. §13 exists
precisely to prevent that. A conflict report puts the divergence in front of an administrator
and leaves the decision with a person, which is the only place it can safely live.

The cost is stated plainly: the two hierarchies can drift, and putting them back is manual.
That is the right trade when the alternative is permission laundering.

---

## 2. Two properties everything depends on

### Every change application is idempotent

The cursor advances **after** a page is applied. A crash in between replays that page, so
applying the same change twice must reach the same state as applying it once.

This is also what makes the round trip safe. The application's own rename (Phase 7) renames
the Drive object, which produces a change, which comes back through this feed. Re-applying it
has to be a no-op — not a second rename, and not an audit entry per poll forever. Every
handler compares before it writes and returns early when the two already agree; a test winds
the cursor back by hand and asserts nothing moves and no second audit entry appears.

### An expired cursor is not an empty page

Drive expires start page tokens and answers a stale one with `404`.

Reading that as "no changes" is the single worst failure available in this phase: the poll
succeeds, the summary says zero, the System page stays green, and the two systems drift apart
permanently and invisibly. Nothing downstream would ever discover it.

So a 404 sets `tokenExpiredAt` and forces a **full reconcile** — re-read every Drive-backed
version and compare it against what Drive currently holds. A fresh cursor is taken *before*
the reconcile starts, so anything that changes during it falls into the next incremental poll
rather than into the gap between the two.

The reconcile is bounded (2,000 objects) and says so in the logs when it stops short. A silent
truncation would read as "everything checked" when it was not.

---

## 3. What runs, and when

| | |
|---|---|
| `npm run drive:sync` | Cron. `DRIVE_SYNC_INTERVAL_MINUTES` (default 15) |
| `POST /api/admin/storage/sync` | Run it now — for "I renamed it in Drive and it still shows the old name" |
| `GET /api/admin/storage/sync` | Cursor state, failure counts, conflict count |

**The first run applies nothing.** It takes a cursor and stops. There is deliberately no
attempt to catch up on what happened before synchronization was switched on: the feed does
not reach back that far, and pretending otherwise would mean inventing a reconcile over a
corpus nobody has asked us to distrust.

A run is bounded by `maxPages`. The cursor persists, so a backlog after a long outage is
worked through over several runs rather than in one burst against a quota shared with the
uploads and downloads employees are waiting on.

---

## 4. Monitoring

**"Shared Drive synchronization"** on the admin System page. Warning, never critical — every
file still opens and every permission still holds; it is the administrator's problem, and they
are the one reading that page.

It reports four things, and the first is the one that matters most:

1. **Never run.** The state a deployment lands in by setting the interval and forgetting the
   cron job.
2. **Stalled** — the last successful run is more than three intervals old (floor: 30 minutes).
   Three rather than one, because a single late run is a slow poll, and a check that cries
   wolf on ordinary jitter gets ignored when it matters.
3. **Failing** — consecutive failures, with the note that nothing is lost because the cursor
   only advances on success.
4. **Conflicts waiting** — items changed in Drive in a way this application does not apply on
   its own. Each needs a person's decision.

---

## 5. Audit vocabulary

Phase 3 reserved these; this phase is the first to write them.

| Action | When |
|---|---|
| `drive_storage.sync_completed` | End of a run; also per file when content changed in Drive |
| `drive_storage.sync_conflict` | A move, a folder change, or an expired cursor |
| `drive_storage.file_missing` | An object removed from Drive. `critical` |
| `resource.archive` / `resource.restore` | Trash and restore mirrored from Drive |
| `file.rename` | A rename adopted from Drive |

Every one is written through `auditService.recordSystem()` with the actor
`system:drive-sync`. Not a synthetic administrator: nobody did these, a poller noticed them,
and running background work as a permission-bearing identity would put someone in the audit
trail who cannot be held to it.

For the same reason a file trashed via the feed has `deletedBy: null`. A false attribution in
the one field that answers "who deleted this?" would be worse than an empty one.

---

## 6. Acceptance criteria

| Criterion (brief, Phase 9) | Evidence |
|---|---|
| Direct Drive changes appear in the application | Edit, rename, trash and restore each tested end to end |
| No duplicate metadata records are created | Nothing in this phase creates a `File` or `FileVersion`. Unrecognised objects are counted and left alone |
| Sync failures are visible and retryable | `consecutiveFailures`, `lastError`, the System check; a failing run is tested to leave the cursor untouched |
| Approved changes trigger review correctly | Tested: an approved document edited in Drive returns to review within the same run |
| Idempotent | Cursor rewound by hand; replay changes nothing and adds no second audit entry |
| Retry-safe | The cursor advances only after a page is applied |
| Handles expired change tokens | Tested, including a change *and* a removal that happened during the gap |
| Manual and scheduled | `POST /api/admin/storage/sync` and `npm run drive:sync` |
| Reports conflicts | Moves and folder changes, on the version/folder record and in the audit log |

### Not done, and deliberately

**Adoption of natively-created documents.** A Google Doc created directly in the Shared Drive
is counted as `unmanaged` and otherwise ignored — no `File` record is created for it. Phase 8
built everything such a document would need (native export, change detection, the editor
route), and the missing piece is small, but adopting an arbitrary Drive object into the
application means deciding its owner, its department, its project, its confidentiality and its
ACL from a filename and a parent folder. Those are guesses with permission consequences.

The honest position is that this needs a product decision — it is open question 4 in the Phase
0 analysis, still unanswered — not a default invented here.

**Permission changes in Drive are not synchronized.** §15 lists "relevant permission changes",
and the relevant response under §13 is that they change nothing here: MongoDB decides access.
Reflecting Drive's sharing into the application's ACL would invert the authority the whole
design rests on.

**Not verified against real Google infrastructure.** The `changes.list` request shape is built
to the documented API and exercised against the in-memory fake, which models the change log,
paging, `newStartPageToken` and token expiry. It has not been run against a real Shared Drive.
That remains part of Phase 2's outstanding manual checklist.
