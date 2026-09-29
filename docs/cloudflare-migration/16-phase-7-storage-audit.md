# Phase 7 — the storage audit

**Status: audit complete, implementation not started.** This document is the classification the
brief asks for before any Drive work begins. It is deliberately separated from the
implementation because the finding changed what the implementation has to be: the problem is not
scattered `fs` calls, it is one pipeline whose *shape* assumes a disk.

---

## 1. What the audit looked for

`fs`, local storage directories, absolute filesystem paths, local upload/preview/copy paths,
Mongo storage-migration utilities, direct `FileModel` / `FileVersionModel` access, and storage
keys interpreted as disk paths.

## 2. Direct filesystem imports — already contained

```
src/server/config/env.ts              path only (path.resolve), no fs
src/server/storage/local-provider.ts  fs, path
src/server/storage/path-safety.ts     path only
src/server/storage/backup-status.ts   path, fs
src/server/storage/google/drive-config.ts  fs — reads a private key from a file
```

That is the complete list, and it is enforced rather than merely observed:
`tests/unit/architecture-boundaries.test.ts` walks `src/` and fails if any file outside
`src/server/storage/` imports `fs`. So "audit every occurrence of `fs`" has a standing answer
that cannot silently regress.

**This is not the problem.** A Worker never loads `local-provider.ts` — the registry only
constructs it when something asks for the `local` provider. The problem is which code asks.

## 3. The two storage surfaces

`storage/index.ts` exposes two, and the distinction is the whole finding:

| Surface | Addressed by | Worker-compatible? |
|---|---|---|
| `getObjectStore(provider)` | a `StorageLocator` naming its own provider | **yes** — a record saying `google_drive` reads from Drive |
| `getStorageProvider()` | a key plus an area, on the local disk | **no** — it *is* the local provider |

Read paths were built on the first. Write paths were built on the second.

## 4. Call-site classification

17 `getStorageProvider()` call sites, in 7 files.

### 4.1 Blocking — a normal employee action fails

| File | Sites | What breaks |
|---|---|---|
| `services/upload.service.ts` | 8 | **every upload**, single-shot and chunked |

This is the whole of the blocking set, and §5 covers it.

### 4.2 Not blocking — operational paths a Worker does not run

| File | Sites | Note |
|---|---|---|
| `bootstrap.ts` | 2 | `ensureReady()` on the local tree; the Worker entrypoint does not call it |
| `health/health-service.ts` | 1 | reports `storage.provider: "local"` — **cosmetic but actively misleading in a Worker**; see §6 |
| `services/integrity.service.ts` | 1 | the on-disk sweep; an operator script, not a request path |
| `services/system.service.ts` | 1 | admin capacity panel |
| `services/migration.service.ts` | 2 | the inbound Drive importer, run from Node |
| `services/storage-migration/transfer.ts` | 2 | local → Drive byte transfer; by definition reads local |

The last two are *supposed* to touch local storage — they are the migration tooling. They must
keep running on Node, and Phase 10 does not change that.

### 4.3 Read paths — already correct

`download.service.ts`, `file.service.ts` and `stored-content.ts` resolve through
`getObjectStore(location.provider)`, so a Drive-backed version is read from Drive with no change.

One exception, and it degrades safely: `stored-content.ts:200` explicitly asks for
`getObjectStore('local')` as a last-resort fallback when a Drive object is missing. In a Worker
the registry has no `local` provider, so that call throws and the surrounding `catch` converts it
to the same `NotFoundError` the no-fallback branch already returns. The behaviour is right; only
the log line ("Served a retained local copy") would be wrong, and it is not reached.

## 5. The finding: Drive is a mirror, not a destination

`upload.service.ts` runs:

```
authorize → open session → stream body to LOCAL quarantine → measure size + checksum
          → read first 4 KB back OFF DISK for the signature check
          → malware-scan the quarantined object
          → move LOCAL quarantine → LOCAL originals
          → record metadata
          → handOffToDrive()   ← Drive enters here, after the bytes are already on a disk
```

`storage/index.ts` says so in its own comment: setting `DEFAULT_STORAGE_PROVIDER=google_drive`
"changes what the registry reports, not where bytes land". So
`GOOGLE_DRIVE_STORAGE_ENABLED=true` is **not** sufficient to make a Worker upload work — it
changes where bytes are mirrored *to*, not where they are first written.

### 5.1 What the Worker version has to be

```
authorize → open session → buffer the first 4 KB in memory → signature check → REJECT EARLY
          → stream the body to a Drive resumable upload in a STAGING folder,
            hashing and counting in a passthrough as it goes
          → verify size + checksum against what the server measured
          → move the Drive file staging → destination (files.update, addParents/removeParents:
            a metadata change, not a byte copy)
          → record metadata
```

Three properties of the current design are preserved by this, and they are the ones that matter:

* **Nothing is accepted before permission, type and quota are decided.** Unchanged — that all
  happens in `authorizeUpload` before a byte is read.
* **Size and checksum are what the server measured, not what the client claimed.** The
  passthrough hash does this as well as the disk write did.
* **Unverified bytes are never at a key a download endpoint can resolve.** The staging folder is
  not in the user-visible tree and no `file_versions` row points at it until the move succeeds.
  Application ACL is authoritative regardless, so a Drive id in staging is not a capability.

The signature check actually gets *stronger*: buffering the head first means a mistyped
extension is rejected before the body is uploaded at all, rather than after it has been written
to disk.

### 5.2 The one genuine design decision — malware scanning

`security/malware-scanner.ts` talks to clamd over **TCP** (`net.connect`, INSTREAM). workerd has
no `net`. There is no port of this scanner to a Worker; there are only three options:

1. **An HTTP-based scanner.** A new `MalwareScanner` implementation posting the buffered stream
   to a scanning API. Preserves the guarantee. Requires a service that does not exist today.
2. **Scan in a Queue consumer, after the upload.** The file lands, then is scanned; an infected
   file is quarantined retroactively. This *weakens* the current guarantee — there is now a
   window in which an infected file is downloadable — and the window is the queue latency.
3. **Accept that a Worker deployment has no malware scanning**, and say so on the admin system
   page exactly as the `disabled` scanner already does.

**This is a business decision with a security consequence, not a mechanical port**, and it is
recorded in `FINAL-READINESS.md` as requiring a human answer. The code should not pick one
silently. Note that option 3 is already a supported configuration on Node
(`MALWARE_SCAN_ENABLED=false` is the default) — so it is not a new risk class, but it *is* a
change in posture for anyone who turned scanning on.

Whatever is chosen, `MALWARE_SCAN_FAIL_CLOSED` must keep meaning what it means today: in
production, a scanner that cannot answer refuses the upload. `env.ts` already forces that and
the Worker path must not quietly relax it.

## 6. `/api/health/ready` reports the wrong provider

`health-service.ts` calls `getStorageProvider()` and reports `storage.provider: "local"`. In a
Worker that string is false, and it is the first thing an operator reads after a deploy.

Cosmetic today because no Worker is deployed. It should be fixed with the pipeline, not before:
changing it in isolation would make the health endpoint claim Drive on a deployment where
uploads still write to a disk, which is worse than being wrong in the honest direction.

## 7. Summary

| Question | Answer |
|---|---|
| Is `fs` scattered through the codebase? | No — confined to `storage/`, enforced by test |
| Do downloads and previews work in a Worker? | Yes, for Drive-backed records |
| Do uploads work in a Worker? | **No** — 8 call sites, one pipeline shape |
| Is `GOOGLE_DRIVE_STORAGE_ENABLED=true` enough? | **No** — Drive is a mirror after a local write |
| Is this an external blocker? | **No** — it is repository work, except the scanning decision |
| What is the largest single item? | Rewriting `upload.service.ts` around a resumable Drive upload |
