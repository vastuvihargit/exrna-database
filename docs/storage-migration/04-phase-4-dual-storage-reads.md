# Phase 4 — Dual-storage read support

Status: **complete and verified**, including against a real database with pre-existing data.

A file whose bytes live in Google Drive now opens exactly like one on this server. Nothing
writes to Drive yet — that is Phase 5 (migration) and Phase 6 (uploads).

---

## 1. What actually needed doing

Less than the plan assumed. `getStorageLocation()` has returned a provider-bearing locator
since Phase 1, and all six read paths already resolved their store from it:

| Path | Status |
|---|---|
| Download | already provider-resolved (Phase 1) |
| Preview | same code path as download |
| File metadata | never touched storage |
| Version access / restore | already provider-resolved |
| File copy | already provider-resolved |
| Trash purge | already provider-resolved |
| Integrity sweep | already provider-resolved, and already degrades correctly |

What was missing was **failure behaviour**. A bare `store.read()` cannot answer either of
the questions that only arise once content really lives in Drive.

---

## 2. A missing Drive object falls back to the local copy

```
read from Drive
   ↓ 404
mark syncStatus = 'conflict'   ← always, even if the fallback then fails
   ↓
localCopyState === 'present'?
   ├─ yes → read the same key/area from local storage, serve it, log a warning
   └─ no  → NotFoundError("currently unavailable"), record still intact
```

**The record is never deleted.** A file that has lost its bytes keeps its metadata,
comments, reviews, approvals and audit history; destroying those would turn a storage
incident into a compliance one.

This is the payoff for `storageKey` staying `required` and never being cleared (Phase 3
§2). It is also why `DELETE_LOCAL_AFTER_MIGRATION` defaults to `false` and why deleting a
local copy is a separate, explicitly-approved admin action.

### The classification is deliberately narrow

`isMissingObjectError()` — `src/server/storage/missing-object.ts`:

| Counts as missing | Does **not** |
|---|---|
| Drive `404` | Drive `403`, `429`, `500`, `503`, timeout |
| local `ENOENT`, `ENOTDIR` | local `EACCES`, `EIO`, `EBUSY`, `EPERM` |

Too broad and a five-minute Google outage marks thousands of healthy versions as conflicts.
Too narrow and a genuinely deleted object surfaces as a 500 while the record claims all is
well. Both directions have tests.

---

## 3. Google-native documents are exported, not read

A Doc, Sheet or Slide holds no bytes; `alt=media` returns `403 fileNotDownloadable`.

| Kind | Exported as | Extension |
|---|---|---|
| `document` | `…wordprocessingml.document` | `.docx` |
| `spreadsheet` | `…spreadsheetml.sheet` | `.xlsx` |
| `presentation` | `…presentationml.presentation` | `.pptx` |

One fixed format per kind, not a user-facing choice. Office formats rather than PDF because
they are what people go on to edit.

Three response consequences, each of which is wrong if ignored:

- **Extension** — the employee receives a `.docx`, so the filename must say so.
- **`Content-Length`** — omitted, not zeroed. `location.size` is 0 for a native document and
  sending that makes the browser save an empty file. `FileStream.contentLength` is now
  `number | null`.
- **Ranges** — `Accept-Ranges: none`, and a range request gets `200` with the whole body
  rather than a `206` claiming a range it did not honour.

There is no local fallback for a native document: it has never had bytes on this server.

---

## 4. What was deliberately left alone

- **The integrity sweep reads without the fallback.** Its job is to verify the *stored*
  object; silently reading the local copy instead is exactly the bug it exists to catch.
- **Quarantine, chunk assembly, capacity** stay local-only. Per decision D1 they stay local
  permanently — bytes are scanned and verified on this server before any external provider
  sees them.
- **`stored-content.ts` never writes to storage.** It does not repair, re-upload or delete.
  A read path that mutated storage would make every download a potential data-loss event.
  Its one write is marking the conflict, which is metadata *about* the failure.

---

## 5. Acceptance criteria

| Criterion | Evidence |
|---|---|
| Local files still open | Existing `preview-download` security suite passes unmodified; live check byte- and header-identical |
| Test Drive files open | Integration suite uploads through the real pipeline, migrates to an in-memory Drive, reads it back byte-identical |
| Permission validation unchanged | A stranger is refused a Drive-backed file **and no Drive call is made on their behalf** |
| API response shapes stable | ETag, Content-Disposition, Content-Length, Content-Range all identical for local files |
| Range requests work against both providers | Tested local and Drive; live `206 content-range: bytes 0-9/71` |
| `getStorageLocation` returns a locator, no casts | Typecheck clean |

---

## 6. Notes for Phase 5

- Migrating a version means: upload, verify, then set `storageProvider`, `googleDriveFileId`,
  `migrationStatus: 'verified'`, `localCopyEligibleForDeletionAt`. **Leave `storageKey` and
  the local bytes alone.** The integration test's `migrateToDrive()` helper is that shape
  already and is a reasonable starting point.
- The unique index on `googleDriveFileId` is live and will reject a duplicate — it already
  did, during this phase's development, when a test fake reused an id.
- `File.storageProvider` (`local` | `google_drive` | `mixed`) is not yet maintained by
  anything. Phase 5 or 6 should update it in the same write that sets `currentVersionId`.
