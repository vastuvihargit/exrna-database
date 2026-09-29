# Phase 3, module 11 — reviews and approvals on D1

**Status: complete.** Reviews, reviewers and approvals have a D1 implementation behind a
contract, the multi-table decision is atomic, and the split-provider combination fails closed.
§8 records the verification. Nothing here is enabled in production.

---

## 1. The invariant this module exists to hold

**An approval belongs to an exact version, and no later version inherits it.**

`reviews.version_id` is required and never rewritten. `version_checksum` is copied at request
time so a decision can be checked against the bytes it signed, and `version_revision_id` /
`version_content_modified_at` pin what Google Drive held at that moment, so a remote edit after
submission is detectable rather than invisible.

A reviewer signs a set of bytes with a known checksum. Uploading v4 cannot retroactively make it
"the approved version" — and the test that proves it asserts on three places at once, because
each could be wrong on its own: the version row's `is_approved`, the file's
`approved_version_id`, and the approval row's own `version_id`.

## 2. One document, three tables

| Mongo | D1 |
|---|---|
| the review document | `reviews` |
| `reviewerUserIds[]` | `review_reviewers` |
| `decisions[]` | `approvals` |

`approvals` is a table rather than a JSON column for two reasons that are not aesthetic. An
approval is the closest thing this system has to a signature, and *"show me every approval Dr
Osei signed in Q3"* against a JSON column is a full scan of every review ever raised. And
`required_approvals` is satisfied by **counting** approve decisions, which against an indexed
table is a different proposition from parsing an array in the application.

`ReviewRecord` reassembles all three, so the service and the API response shapes are unchanged
by the flag.

## 3. A decision is four writes, and they commit together

Approving does not only close a review:

```
reviews          status → 'approved', closed_at set
approvals        the decision row appended
file_versions    is_approved, approved_by, approved_at, the Drive approval binding
files            approval_status → 'approved', approved_version_id → this version
```

On MongoDB all four ran in one session. On D1 there is no interactive transaction and
`withTransaction` opens a *Mongo* session, which governs no D1 statement. Run as separate
batches, a failure between them leaves a state that is not self-announcing:

* a review closed as approved while the version still reads `is_approved = 0` — the badge is
  absent and a second reviewer can be asked to approve it again;
* **or the reverse**: a version marked approved and bound to a Drive revision under a review
  that never closed. That is an approval nobody signed, and it is the one that matters, because
  the whole version-pinned design exists so that an approval means *these exact bytes, by this
  person, at this time*.

`d1-review-unit-of-work.ts` composes the statements from three repositories into one
`db.batch()`. It is a separate module from `d1-unit-of-work.ts` because that file's own header
says a new operation should arrive as a named function with its own plan type rather than as a
generic statement runner — reviews share no planning code with a folder move.

The service computes **one** pair of patches and the branch below decides only *how* they
commit, never *what* they are. Two paths reading from one pair of patches is what stops
"approved on Mongo" and "approved on D1" quietly meaning different things after the flag moves.

## 4. The race guard, and why statement order is load-bearing

Two reviewers deciding at the same moment must not both close the request. The guard is
`status = 'pending'` **inside the statement**, and the empty `RETURNING` is how the loser learns
it lost.

The decision row is inserted with the *same* guard, as an `INSERT … SELECT … WHERE status =
'pending'`, and it is ordered **before** the status update. That ordering is not arbitrary: the
update is what makes the request non-pending, so an insert placed after it would fail its own
guard and silently record nothing while the request closed.

The loser writes **nothing** — not a decision row against a request somebody else closed with a
different outcome. That is Mongo parity: `findOneAndUpdate({status:'pending'})` does not `$push`
when it matches nothing.

### One implementation note worth keeping

The guarded insert is written as `db.insert(approvals).select(sql\`SELECT … WHERE …\`)`, not as
`db.run(sql\`INSERT … SELECT …\`)`. A fully raw statement **cannot be batched** by this drizzle
version: `SQLiteRaw._prepare()` returns itself and carries no `stmt`, so `session.batch()`
dereferences `undefined`. The failure surfaces as a `TypeError` inside drizzle rather than
anything resembling a SQL problem, which is why it is recorded here and at the call site.

## 5. A new version cancels every open request, in the same batch

The version service documented this rule and could not enforce it inside its batch while
reviews were on MongoDB. Now `createVersionWithFile` appends
`buildCancelOpenForFileStatement` when `DATA_SOURCE_REVIEWS=d1`.

It is a named domain rule, not a generic hook. A review pinned to the previously current bytes
is a review of content that is no longer current, and leaving one open lets a reviewer approve
it afterwards — which would set `files.approved_version_id` to a superseded version *after* the
file had already moved on.

Submitting spares a request against the version being submitted, or re-submitting the same
version would cancel itself.

## 6. Three flags, not two

`reviewMutationEngine()` refuses unless `DATA_SOURCE_REVIEWS`, `DATA_SOURCE_FILES` **and**
`DATA_SOURCE_FILE_VERSIONS` all agree. An approval binds `files.approved_version_id` *and*
`file_versions.is_approved`, so reviews agreeing with files while versions sit elsewhere is just
as split as the obvious case. All four unsafe combinations are tested.

## 7. What this module does not do

**No authorization.** The repository takes no `Actor` on either engine, and neither does the
unit-of-work. `review.service.ts` calls `requireFile` first and then checks the review belongs
to that file — a review id is not a capability, exactly as a version id is not. That boundary
is proved in `tests/security/review-and-approval.test.ts`.

**No repair.** `validateReviewGraph` reports and never fixes, the same rule as the version
validator. A migration that silently corrected a review would be a migration that changed who
approved what.

## 8. Verification

`tests/d1/review-repository.test.ts` — **30 tests, all passing** against real D1 through
Miniflare.

**Atomicity, by real constraint violation** rather than by mocking `withBatch`: a submit whose
file half names a folder that does not exist leaves no review, no reviewer rows and an untouched
version; a decision whose file half fails leaves the request `pending` with no decision recorded;
a decision whose version half names a non-existent `approved_by` does the same. The last two are
the ones that matter — the review half was valid and would have committed alone.

**The race**, run as two concurrent `decideReviewAtomically` calls with opposite outcomes:
exactly one returns a record, the request ends in one of the two states, and exactly **one**
decision row exists. A late decision against a closed request returns `null` and leaves the
file's `approval_status` as the winner set it.

**Version binding**: v1 stays approved with its approver and Drive revision intact while v2
arrives unapproved, the file's pointer clears, and the approval row still names v1.

**Everything else**: the partial unique index refusing a second open request per version; a
stale request on another version cancelled while this one is spared; `required_approvals: 2`
holding the request open through the first decision and closing on the second; withdrawal
returning file and version to draft and being a no-op the second time; the reviewer dashboard
not duplicating a request that names one person twice, in the rows *or* the total; cross-tenant
isolation; purge cascading to reviewers and approvals; all four split-provider refusals; and the
validator's four checks with a re-run proving it changed nothing.

### Gates

| Gate | Result |
|---|---|
| `tests/d1/review-repository.test.ts` | 30 passed |
| Full D1 suite | recorded in the Phase 2 document's gate table, run together |
| Full Mongo suite | as above |
| Typecheck / lint | clean |

## 9. Rollback

Revert the commits. `DATA_SOURCE_REVIEWS` is unset, so the façade returns the MongoDB
implementation and `reviewMutationEngine()` returns `mongo`.

The service refactor **is** shared: both engines now read one pair of patches computed before
the branch. It is behaviour-preserving on the Mongo path — the same patches, applied in the same
order, in the same session — and is covered by the existing Mongo review suite.
