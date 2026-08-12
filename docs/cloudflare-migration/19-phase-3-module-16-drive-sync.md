# Phase 3, module 16 — the Drive change-feed cursor

**Status: complete.** This was the last repository reachable from a Worker without a D1
implementation. §5 records the verification.

The two repositories that still have none — `migration` and `storage-migration` — read the local
filesystem by definition and are supposed to keep running on Node. **The repository migration
list is now closed.**

---

## 1. Why a background module was on the list at all

Nothing a user does reaches this repository. It still had to move, and the reason is worth
stating because it applies to anything else that looks like "background so it can wait":

The sync job runs *in the Worker*, as a cron trigger or a queue consumer, and a Worker cannot
open the TCP socket Mongoose needs. Left on MongoDB, Drive synchronization would simply stop
after cutover — and the symptom would be renames, moves and deletions made in Drive silently
never appearing in the application. No error, no alert, just an archive slowly drifting away from
the Shared Drive it mirrors.

## 2. The signature changed, and that was the point

`updateState` took a raw `{ $set, $inc }` MongoDB document. Beyond having no D1 equivalent, that
signature let **any caller write `startPageToken` unconditionally**.

The cursor has exactly one safe way to move: `advanceCursor`, which is conditional on the token
the caller read. A `$set` bypassing it would defeat the concurrency guard without looking like it
was doing anything unusual — it is one field name among six in an object literal.

`DriveSyncStateUpdate` is a closed set. `startPageToken` is still writable, but only through a
named field, and the two call sites where an unconditional write is correct now carry a comment
saying why:

* **Taking the very first cursor.** There is no cursor yet, so there is nothing for a conditional
  write to be conditional on.
* **Taking a fresh one after a full reconcile.** The old cursor expired — that is what a
  reconcile means.

## 3. Two places where the SQL is not a transliteration

### 3.1 `advanceCursor` compares with `IS`, not `=`

The first advance of a drive's life has `from === null`, and `start_page_token = NULL` evaluates
to NULL in SQL — never true. An `=` comparison would make the very first cursor silently
unwritable.

The symptom is the dangerous part: every poll would take a cursor, fail to store it, report
success, and re-initialize on the next run. Drive sync would look healthy and see nothing, for
ever. `IS` is SQLite's null-safe equality and handles both cases in one statement.

A test drives exactly this path, because it is not reachable from any test that starts from an
already-initialized drive.

### 3.2 `ensureState` upserts with `DO NOTHING`, not `DO UPDATE`

`ensureState` runs at the top of every poll. An upsert that reset `state` to `'idle'` would clear
the `failed` flag and the `lastError` an operator is looking at, every few minutes.

`DO NOTHING` followed by a SELECT gets the same result for the creating case — the insert is a
no-op for the loser of a race, and both callers then read the same row — without touching an
existing one. Pinned by a test that fails the row, calls `ensureState` again, and asserts the
failure is still there.

## 4. Failure counting is an increment, on both engines

`incrementFailures` maps to `$inc` on MongoDB and `consecutive_failures = consecutive_failures + ?`
on D1, never a read-modify-write.

Two workers failing on the same drive would otherwise each read the old count and write their
own, and the counter would under-report at exactly the moment it is being watched — which is when
somebody suspects Drive sync is broken and is looking at this number to decide.

## 5. Verification

| Gate | Result |
|---|---|
| `tests/d1/drive-sync-repository.test.ts` | **28 tests, both engines, passed** |
| `tests/integration/drive-sync.test.ts` | **15 tests, passed** against the new signature |
| `npm run typecheck` | clean |
| `npm run lint` | clean |

The suite asserts the cursor cannot wind backwards from a stale read, that exactly one of two
concurrent advances wins, that a refused advance applies none of its counters either, that the
expiry marker is cleared when the cursor advances again, and that counters accumulate across
pages rather than being overwritten per page.

## 6. Flag ordering

`DATA_SOURCE_DRIVE_SYNC` depends on `organizations` alone — that is the only foreign key on
`drive_sync_states`.

In practice it should move **with** `files`, `folders` and `fileVersions`, because applying a
Drive change writes all three. That is a runbook ordering point rather than something the
database can enforce, so it is recorded here and in the cutover procedure rather than in
`DATA_SOURCE_DEPENDENCIES`, which deliberately records only real foreign keys.
