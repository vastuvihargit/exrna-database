# Phase 3, module 14 — the support repositories

**Status: complete.** Login history, application settings, storage accounting, the activity
timeline, comments and upload sessions have D1 implementations behind contracts. §7 records the
verification. Nothing here is enabled in production.

This module took the count of repositories with **no D1 implementation from ten to four**, and
two of those four are Node-only tooling that needs none.

---

## 1. Why these six

They are not a theme. They are what was left on the request path after module 13, and the phase
plan never named them because it was written around user-facing features rather than around
"what does a Worker touch". `00-phase-0-analysis.md` §4 is the reason that distinction matters:
a Worker cannot open the TCP socket Mongoose needs, so *every* repository a request reaches has
to be on D1, not only the ones with a feature attached.

| Repository | Reached by | Was blocking |
|---|---|---|
| `login-history` | every authentication attempt | login |
| `storage-usage` | every upload and every quota check | upload |
| `app-setting` | runtime configuration reads | admin pages |
| `activity` | the "what happened here" timeline | folder and project pages |
| `comment` | file discussion | the file detail panel |
| `upload-session` | every upload | upload |

## 2. Login history — the write that must never fail

`record()` runs on **every** attempt, including the failing ones, before the error is thrown.
Three consequences, and all three are handled in the repository rather than left to callers:

1. **It must not throw.** If a transient database problem can fail this write, "wrong password"
   becomes a 500 — and worse, an attacker who can make it fail can suppress their own audit
   trail. Both implementations log and swallow. This is the one place in the repository layer
   where that is correct: the permanent record of a security event is the audit log, which is
   written separately and has no expiry. Losing a login-history row degrades a diagnostic view.

2. **`user_id` is null by definition on the `unknown_user` path.** There is no account, so there
   is nothing to reference — and on D1 that column is a real foreign key.

3. **An id that does not resolve must not abort the insert.** The Mongo path stored whatever
   ObjectId it was handed. D1 cannot, so the implementation resolves `user_id` and `session_id`
   before inserting and drops an unresolvable one to NULL. The email and the outcome are what
   the row exists for; the pointer is the least important field on it.

`session_id` connects to a decision made in module 13: the session sweep **detaches** this column
rather than cascading, precisely so these rows outlive the sessions they describe.

## 3. Storage accounting — two silent failure modes

### 3.1 A negative counter is a quota bypass

`remainingBytes = max(0, quota - used)`. If `used` goes negative, the subtraction produces more
than the quota and the counter reads as *unlimited remaining*.

That is reachable, not theoretical: a file moved between departments before a drift was corrected
subtracts bytes the destination counter never held. So the delta is
`MAX(0, storage_used_bytes + ?)` on D1 and the shared `quotaState()` clamps on read for both.

### 3.2 Losing bytes to a race

The delta is arithmetic **inside the statement** on both engines — `$inc` on Mongo,
`SET storage_used_bytes = storage_used_bytes + ?` on D1 — never a read-modify-write. Two
concurrent uploads by the same person that both read the old total and both wrote their own
would leave the loser's bytes on disk and invisible to the quota: silent, cumulative, and
discovered when a volume fills. A ten-way concurrent test pins it.

The three counters an upload touches — user, department, project — go in **one batch**, so a
failure cannot leave the department charged for bytes the user is not. That drift would later be
"fixed" by `recomputeAll` overwriting both, hiding that anything went wrong.

### 3.3 `recomputeAll` is three statements, not a corpus in memory

The Node implementation does `FileModel.find({})` over every file in the archive and aggregates
in JavaScript — exactly the shape a Worker cannot afford. The D1 version is three
correlated-subquery `UPDATE`s.

Two details worth keeping:

* **No zeroing pass.** `COALESCE(SUM(…), 0)` already yields 0 for a row that owns nothing, and a
  separate `SET storage_used_bytes = 0` would open a window in which every quota reads as empty —
  an upload landing in that window is admitted against a counter about to be overwritten.
* **Soft-deleted files are included.** A trashed file still occupies storage until it is purged.
  A quota that forgot it would make the trash free space.

## 4. Activities and comments — two tables, one write

Both had an array on the Mongo document that becomes a table on D1: `contextFolderIds` →
`activity_folders`, `mentionedUserIds` → `comment_mentions`. In both cases the reason is that the
array is *queried* — "everything under this folder", "mentions of me" — and a JSON column cannot
be indexed for it.

Each write is therefore one `batch()`, because the half that can fail is the half nobody notices:
an activity that lost its folder links is invisible in exactly the view it was written for while
still appearing on the entity timeline; a comment whose mention rows failed to write notifies
nobody while looking normal in the thread.

### 4.1 `listForFolderTree` is a UNION, not a join

The join form returns **one row per matching folder link**, so an activity recorded against three
ancestor folders appears three times — and `LIMIT 50` then returns fewer than 50 distinct
entries while claiming otherwise. A test asserts a doubly-linked activity appears once.

### 4.2 D1 counts cascaded deletions

`meta.changes` includes rows removed by `ON DELETE CASCADE`, not only the rows the statement
named. An activity with two folder links reports as **three** removals, and a comment purge
reports its mention rows too.

Both sweeps therefore count with `RETURNING` instead. The test that pins this uses a row with
*two* links deliberately: with one link the count is off by exactly one, which looks plausible
enough to survive review.

That number is not cosmetic — it is what an operator reads to decide whether retention is
working.

## 5. Upload sessions — two concurrency controls

### 5.1 The finalization claim is a lock

```sql
UPDATE upload_sessions SET status = 'processing', finalization_key = ?
 WHERE id = ? AND status IN ('uploading','pending') AND finalization_key IS NULL
RETURNING …
```

Only the caller that moves the session out of `uploading` may build the file. A client that timed
out and retried finds nothing to claim and reads the stored result instead — which is the whole
idempotency story. SQLite serializes the writers, so exactly one gets rows back; a three-way
concurrent claim test asserts it.

### 5.2 `markFailed` must not overwrite a decision

`ready`, `rejected` and `aborted` are terminal. A file **rejected for its content** is a
different thing from an upload that broke, and the admin review of quarantined uploads has to
tell them apart. The filter is in the statement, so a concurrent rejection cannot be overwritten
in the gap a read-then-write would leave.

### 5.3 `recordChunk` could not be ported directly

`$addToSet` has no SQLite equivalent. Adding the index unconditionally would double-count a
re-sent chunk's bytes, making a resumable upload report more received than it holds — and
finalize early, on an incomplete file.

The index and the byte count are governed by **one predicate in one statement**:

```sql
   SET received_chunks = json_insert(received_chunks, '$[#]', ?),
       received_bytes  = received_bytes + ?
 WHERE id = ? AND NOT EXISTS (
         SELECT 1 FROM json_each(received_chunks) WHERE value = ?)
```

So a duplicate changes *neither*, rather than one of the two. It returns the session unchanged
rather than null, because to the caller a chunk already stored is a success.

### 5.4 The patch type is the authorization boundary

`update` took `Record<string, unknown>` and every caller passed `{ $set: … }` — a MongoDB
operator D1 cannot honour. It is now a typed patch the Mongo side wraps.

The **omissions** are the point: `organizationId`, `userId`, `folderId`, `targetFileId`,
`declaredSize` and `declaredFilename` were decided by `authorizeUpload` against a permission
check and a quota, and nothing downstream — a chunk handler, a finalizer, a retry — may revise
them. Making that a type error is cheaper than making it a review comment, and the typechecker
immediately found three test call sites doing it.

`expiresAt` needs an explicit `Date` → ISO conversion on the way in. Spreading the patch through
would store `"[object Date]"`, and the comparison in `listExpired` would then never match —
leaving abandoned uploads holding quarantined bytes indefinitely.

## 6. What having these does *not* achieve

Worth stating plainly, because a green flag here invites the wrong conclusion.

`DATA_SOURCE_UPLOAD_SESSIONS=d1` does not make uploads work in a Worker. The pipeline still
streams bytes to a **local quarantine directory**, reads the head back off disk for the signature
check, scans, moves to local `originals`, and only then mirrors to Drive. This module is the
metadata half, finished ahead of the byte half. See
`16-phase-7-storage-audit.md`.

## 7. Verification

| Gate | Command | Result |
|---|---|---|
| Support repositories, both engines | `vitest run --config vitest.d1.config.ts tests/d1/support-repositories.test.ts` | 76 passed |
| Full MongoDB suite | `npm run test:mongo` | 51 files, 768 tests passed |
| Typecheck | `npm run typecheck` | clean |
| Lint | `npm run lint` | clean |

Full-suite D1 figures are in `FINAL-READINESS.md`.

## 8. What remains in this area

* **`inventory-item`** — no D1 implementation, and separately the stock-movement feature the
  brief's Phase 5 describes (add, issue, no-over-issue, immutable history) is not implemented at
  all. The D1 schema anticipates it in full, including the `CHECK (quantity >= 0)` constraints
  and the append-only triggers; `schema/inventory.ts` documents the conditional-UPDATE approach
  that replaces MongoDB's atomic `findOneAndUpdate`. The design decision is made; the code is not
  written.
* **`drive-sync`** — the Drive change feed. Background rather than request-path, but a Worker
  running the sync needs it.
* **`migration` and `storage-migration`** — Node-only tooling. They read the local filesystem by
  definition and must keep running on Node; they need no D1 implementation for cutover.
