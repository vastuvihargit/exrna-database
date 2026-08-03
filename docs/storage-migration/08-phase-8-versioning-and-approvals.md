# Phase 8 — Versioning and approvals across providers

Versioning already worked across providers before this phase: Phase 3 gave every version its
own storage fields, Phase 4 reads them, Phase 5 migrates them and Phase 6 writes new ones. A
file whose v1 is local and v2 is in Drive has been an ordinary, tested state since Phase 3.

What did **not** work is the thing this phase exists for.

---

## 1. The problem: an approval is a claim about bytes we stopped controlling

Every approval in this system is pinned to a version, and the version model enforces that the
content-identity fields — `checksumSha256`, `fileSize`, `mimeType`, `originalFilename` —
cannot be modified after the fact. That was a *complete* guarantee for exactly as long as the
bytes lived on our own disk under a key nothing rewrites.

It stopped being complete the moment content moved into a Shared Drive.

A Google Doc can be rewritten by anyone who can open it. A binary file in Drive can be
replaced with a new revision. **Neither event changes anything in the version document.**
Same checksum, same size, same `isApproved: true`. The record would go on saying "Priya
approved this on the 3rd" over content Priya never saw.

§11 of the brief is unambiguous about the required behaviour, and it is worth quoting because
it names both halves:

> If an approved Google-native file changes, mark it as requiring review again.
> **Do not silently keep the old approval status.**

---

## 2. The asymmetry that shapes the whole implementation

The obvious way to detect a change is `files.get` and compare `headRevisionId`. It is wrong,
and wrong in the worst possible way — silently.

From the Drive v3 reference, `headRevisionId` is populated **only for files with binary
content stored in Drive**. For a Google Doc, Sheet or Slide it is simply absent. An
implementation that compared it would compare `undefined` to `undefined`, conclude "no
change", and report every edited Doc as still approved, forever. It would pass a casual test
against an uploaded PDF and fail in production against exactly the file type §11 is about.

So the binding reads the **head revision resource** instead:

```
GET /files/{fileId}/revisions/head?fields=id,mimeType,modifiedTime,md5Checksum,size
```

`head` is a documented alias for the current revision, and revisions exist for native
documents as well as binary ones. One request per approval, either way.

This is asserted directly rather than trusted: `tests/helpers/fake-drive.ts` now leaves
`headRevisionId` undefined for native documents, exactly as the real API does, and the
Google-native test confirms that premise (`expect(...headRevisionId).toBeUndefined()`) before
asserting that an edit is still detected. Anyone who "simplifies" this back to `files.get`
gets a failing test rather than a silent regression.

---

## 3. Three operations, and one thing that is never done

| | |
|---|---|
| **Bind** | When an approval closes, the exact revision it was granted against is recorded on the version (`approvedRevisionId`). |
| **Check** | Ask Drive for the current revision and compare. |
| **Return to review** | On a mismatch the file goes back to `changes_requested`, its owner and its approver are told in plain language, and an audit entry is written. |

**The approval record is never deleted or rewritten.** The Review document keeps its status,
its decisions, its reviewers, their comments, their IPs. The version keeps `approvedBy` and
`approvedAt`. "Nobody approved this" and "this was approved by Priya on the 3rd, and the
document has since changed" are different claims, and only the second is true.

What *is* cleared is `isApproved`, because that is what the badge and the approved-files list
read — and a document whose content has changed must not appear in either. That is the whole
distinction between marking an approval stale and destroying the evidence for it.

### The four outcomes, and why `unavailable` is separate

| Outcome | Meaning | Effect |
|---|---|---|
| `unbound` | Local content, or already marked stale | Nothing. Local bytes are immutable; there is nothing that could drift |
| `unchanged` | Revision matches | Nothing at all — the row is not written to |
| `superseded` | Revision differs | Approval marked stale, file back to review, owner and approver notified, audited |
| `unavailable` | Drive did not answer | **Approval retained**, counted, re-checked next run |
| `missing` | The object is gone from Drive | Storage conflict recorded (§16). Approval retained — it did not *change*, it became unreachable |

`unavailable` being distinct from `unchanged` is the single most important line in this
design. If a Drive outage were recorded as "no change", one bad hour would silently certify
the entire corpus as still-approved. "We could not tell" is never written down as "it is
fine", and the count is on the admin System page.

`missing` being distinct from `superseded` matters for the same reason in reverse: an
unreachable document has not been edited, and sending it back to review would be a false
statement about what happened to it.

---

## 4. Where the check runs

Three entry points, one implementation:

| Trigger | Use |
|---|---|
| `npm run drive:check-approvals` | Cron. One page per run by default; `--all` walks the corpus |
| `POST /api/admin/storage/approval-check` | An administrator who has just been told a document was edited |
| `checkApprovedVersion(versionId)` | Phase 9 will call this when a change arrives for a specific file |

The sweep is bounded and cursor-resumable rather than run-to-completion. It is one Drive call
per live approval, against a quota shared with the uploads and downloads employees are
actually waiting on, so a nightly job must not become one unbounded burst.

Rows already marked superseded are excluded from the work list. Re-checking them would spend
a call per file per run to re-learn something already recorded and already acted upon.

---

## 5. Approving something that moved while you were reading it

The same asymmetry applies inside a single review cycle, so the review request now pins the
revision too (`Review.versionRevisionId`), and `decide` re-reads it.

- **Approving** a document whose revision has changed since submission is refused
  (`CONTENT_CHANGED`). The approval would otherwise cover bytes the reviewer never saw.
- **Rejecting or requesting changes** on it is still allowed. The reviewer has seen enough,
  and blocking it would leave the request stuck open with no way to close it.

Reading the revision at submission time is deliberately non-fatal: a Drive hiccup must not
stop somebody submitting their work. The consequence is that such a review is pinned by
checksum alone — the pre-Phase-8 behaviour, weaker but not wrong — and the sweep still covers
the file once it is approved.

---

## 6. Backward compatibility: approvals that predate the binding

Every field added in this phase defaults, so existing documents remain valid with no backfill
and every existing approval remains valid.

An approval granted before Phase 8 has no `approvedRevisionId`. Both obvious readings of that
are wrong:

- Treating it as a **mismatch** would send every historic approval back to review over a
  change that never happened.
- Treating it as a permanent **match** would leave it unwatched forever.

So the first check **adopts** the current revision as the binding and reports `unchanged`.
From that moment it is watched like any other. A test asserts exactly this, including that
the next edit is then detected.

---

## 7. Google-native documents

Phase 4 already exports Docs, Sheets and Slides on download and refuses to range-read them.
This phase adds the two remaining pieces of §11:

**Change detection**, above — the only part with real machinery behind it.

**Opening in the Google editor** — `GET /api/files/{id}/open`, a 302 rather than a JSON
payload containing the URL, because a Drive URL is a storage location and this codebase does
not put locations in response bodies. It is gated three ways:

1. `file.download` permission, not `file.preview`. The Google editor is an editor.
2. The version really is native, with a stored `webViewLink`. No URL is ever constructed from
   a file id.
3. `GOOGLE_DRIVE_NATIVE_EDITOR_ENABLED`, **off by default**.

That last one is not caution for its own sake. Every Drive operation in this application runs
as the service account; an employee's own Google identity is not necessarily a member of the
Shared Drive at all — §13 says explicitly that employees "should not require direct access to
every underlying Shared Drive file unless the product intentionally supports it". A deployment
where that is untrue would show a button leading to a Google permission-denied page, which
looks like a bug in this application and cannot be fixed from here.

When it *is* on, the honest statement is: what somebody may do inside the Google editor is
governed by Drive's sharing, not by this application's permissions. That is in `.env.example`
where the administrator turning it on will read it.

The access is recorded before the redirect, because afterwards this application can observe
nothing at all.

---

## 8. Schema changes

All additive, all defaulted.

**`FileVersion`**

| Field | Purpose |
|---|---|
| `approvedRevisionId` | The revision an approval was granted against |
| `approvedContentModifiedAt` | When Drive said that revision was modified |
| `approvalSupersededAt` | Set when a check finds the content no longer matches |
| `approvalSupersededReason` | A plain sentence, safe to show an employee |
| `googleDriveModifiedTime` | Last observed content-modified time (also used by Phase 9) |

Plus one partial index on `{ storageProvider, approvalSupersededAt, _id }` filtered to
`isApproved: true` — the sweep's work list, and a small fraction of any real corpus.

**`Review`**: `versionRevisionId`, `versionContentModifiedAt`.

**Immutability hook**: the four approval fields and `googleDriveModifiedTime` were added to
`MUTABLE_PATHS`. The content-identity fields are untouched and must stay that way — the note
in `file-version.model.ts` explains why widening it further would let a migration hide a
corrupt transfer by recording the corruption as expected.

---

## 9. Audit and notification vocabulary

- Audit action **`file.approval_invalidated`**, filed under `file.*` rather than
  `drive_storage.*` on purpose: an auditor asking "what happened to this approval?" reads the
  file's history, and an entry filed under storage plumbing would not be there.
- `auditService.recordSystem()` — §17 requires every entry to name "a user **or system**
  actor", and this is that second case. The actor is recorded as
  `system:approval-integrity`, never a synthetic administrator: running background work as a
  permission-bearing identity would put someone in the audit trail who cannot be held to it.
- Notification type **`review.reopened`**, sent to the owner and to whoever approved it.

Deliberately **no activity-feed entry**. That feed answers "who did what" and its actor is a
required reference to a real person. Nobody did this — a document changed and a sweep noticed
— and inventing a user for it would put a fictional person in the one view colleagues read to
find out who touched their work.

---

## 10. What an employee sees

No revision ids, no Drive vocabulary, no storage provider — §19 throughout.

- A file that is no longer approved shows **Changes requested**, as it would for any other
  reason.
- The details panel says: *"The document was changed in the company Shared Drive after it was
  approved. It needs reviewing again — the earlier approval is kept in the file's history."*
- The version row shows **Needs review again** rather than **Approved**.
- The owner and the approver get: *"'X' changed after it was approved and needs reviewing
  again"*.

The administrator, and only the administrator, gets the count on the System page —
**"Approved documents that changed"**, a warning while non-zero, never critical. Nothing is
broken for anybody using the application; something needs a person's attention, and they are
the person reading that page.

---

## 11. Acceptance criteria

| Criterion (brief, Phase 8) | Evidence |
|---|---|
| Existing approvals remain valid | Every field defaults; unbound approvals adopt the current revision rather than being invalidated — tested |
| Approval is tied to a specific version | Unchanged from Phase 8 of the original build, and now also to a specific *revision* |
| Changed approved documents return to review | Tested for a binary file and, separately, for a Google Doc with no `headRevisionId` |
| Old versions remain accessible | Unchanged; the superseded version keeps its storage fields and is still readable |
| Drive revisions connected to MongoDB versions | `approvedRevisionId` / `googleDriveRevisionId`, written on approval and on detection |
| Version notes preserved | Untouched; still the one mutable field on a stored version |
| Approval checksums | `versionChecksum` still pins the record; the revision pins the content |

**Not verified against real Google infrastructure.** The `revisions/head` request shape is
built to the documented API and exercised against the in-memory fake, which now models the
native/binary asymmetry deliberately. It has not been run against a real Shared Drive — that
remains part of Phase 2's outstanding manual checklist, and it is the largest untested
surface in this work.

---

## 12. Operating it

```bash
npm run drive:check-approvals            # one page, for frequent cron
npm run drive:check-approvals -- --all   # walk everything
```

Exit code 1 when anything needs a person: an approval returned to review, a document missing
from Drive, or a file that could not be checked. None of those implies data loss.

Suggested schedule: hourly. Phase 9 will make most of this reactive — the Changes feed knows
which files moved — but the sweep stays, because a sweep that asks every question is the only
thing that catches what a change feed missed while its token was expired.
