# Phase 2 — Google Drive provider

Status: **complete in code, unverified against a real Shared Drive.**

The provider works, is fully tested offline, and is switched off. Nothing in any production
path touches it. This document is what to do to connect it, and how to prove it works before
Phase 5 moves a single real file.

---

## 1. What Phase 2 added

| Module | Responsibility |
|---|---|
| `server/storage/google/drive-config.ts` | The **only** module that reads the service-account key |
| `server/storage/google/drive-auth.ts` | Access tokens, via `google-auth-library` |
| `server/storage/google/drive-client.ts` | The **only** module that speaks HTTP to Drive |
| `server/storage/google/google-drive-object-store.ts` | `ObjectStore` + `HierarchicalStorageProvider` |
| `server/storage/google/drive-errors.ts` | Retryable vs. fatal, and backoff |
| `server/storage/google/drive-health.ts` | Connection check (metadata calls only) |
| `app/api/admin/storage/drive/route.ts` | Admin connection status |

New dependency: `google-auth-library` (only). The full `googleapis` package is ~50 MB of
generated surface for the twelve endpoints used here.

---

## 2. Setting up the Google side

Once, by a Workspace administrator.

1. **Create a Shared Drive.** Not a folder in someone's My Drive. A Shared Drive owns its
   own content, so files survive the employee leaving — and a service account has no
   personal storage quota to write against, so a My Drive target fails outright.
2. **Create a Google Cloud project**, enable the **Google Drive API**.
3. **Create a service account** in that project. No roles are needed at the project level:
   its access comes entirely from Shared Drive membership.
4. **Create a JSON key** for it and download it once.
5. **Add the service account's email as a member of the Shared Drive**, with the
   **Content Manager** role.

   This is the step everyone misses. Without it the key is valid, the API answers, and every
   call 404s. The connection check names this explicitly for that reason.

**Do not enable domain-wide delegation.** It would let this key impersonate any employee in
the domain, turning a leaked environment variable into a full-domain compromise. Nothing
here needs it — Shared Drives accept service accounts as members directly, and MongoDB
remains the authoritative permission model.

---

## 3. Configuring this application

```env
GOOGLE_DRIVE_STORAGE_ENABLED=true
DEFAULT_STORAGE_PROVIDER=local          # ← stays local until Phase 6

GOOGLE_SHARED_DRIVE_ID=0AB...           # from the Drive URL
GOOGLE_DRIVE_ROOT_FOLDER_ID=1XY...      # optional; blank = drive root
GOOGLE_WORKSPACE_DOMAIN=company.com

GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL=drive-storage@project.iam.gserviceaccount.com
GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE=/run/secrets/drive-key.pem
```

The `private_key` field of the downloaded JSON, written to that path as a real PEM.

**In production use `_PRIVATE_KEY_FILE`, not `_PRIVATE_KEY`.** The inline form exists for a
developer machine. It is reported as a warning on `/admin/system` in production rather than
refused, because refusing would take down a running deployment over a key-handling
preference — but it should not stay that way.

### The boot refusals

The process will not start if:

- `DEFAULT_STORAGE_PROVIDER=google_drive` while `GOOGLE_DRIVE_STORAGE_ENABLED=false`
- the backend is enabled without a drive id, a service-account email, or a key
- `DELETE_LOCAL_AFTER_MIGRATION=true` with `LOCAL_COPY_RETENTION_DAYS=0`

Each of these would otherwise surface hours later as a failed upload with a stack trace
instead of a cause.

---

## 4. Manual verification, before Phase 5

Everything below runs against a **scratch folder** inside the Shared Drive. Phase 2 touches
no application data, so none of this can affect existing files.

### 4.1 Connection

```
GET /api/admin/storage/drive        (as an administrator with company-wide audit.view)
```

Expect `connected: true`, the drive's real name, and `canAddContent: true`.

The failures worth provoking deliberately, because each has a distinct message and you want
to know you would recognise it:

| Do this | Expect |
|---|---|
| Remove the service account from the Shared Drive | `not a member of the Shared Drive` |
| Change its role to Viewer | `Change its membership to Content Manager` |
| Point `GOOGLE_DRIVE_ROOT_FOLDER_ID` at a folder in a personal My Drive | `not inside a Shared Drive` |
| Point it at a folder in a *different* Shared Drive | `belongs to a different drive` |
| Corrupt one character of the key | `not a PEM private key` on `/admin/system` |

### 4.2 Round trip

Not yet reachable from the UI — by design, since no production path is wired. Use a
scratch script against `getGoogleDriveStorage().store`:

1. `ensureFolder` → a folder appears in the Shared Drive; call it again → **no second
   folder appears**. This is the one to actually watch in the Drive web UI.
2. `put` a file of ~50 MB with a known checksum → `checksumMd5` matches your own, and the
   file appears with the right size.
3. `read` it back → bytes are identical.
4. `read` with a range → the correct slice.
5. `renameItem`, `moveItem`, `trashItem`, `restoreItem` → each reflected in the Drive UI,
   and `moveItem` leaves the file in **one** place, not two.
6. `put` again with a deliberately wrong `expectedMd5` → it fails **and leaves nothing
   behind** in the drive.

### 4.3 Confirm the flag genuinely disables it

Set `GOOGLE_DRIVE_STORAGE_ENABLED=false`, restart, and confirm `/api/health/ready` reports
`drive: { status: 'disabled' }` with the application otherwise unchanged. The automated test
asserts no Google call is made; this confirms it end to end.

---

## 5. Known gaps, carried into later phases

| Gap | Phase |
|---|---|
| No schema fields, so nothing can *record* a Drive location yet | 3 |
| Reads of Drive-backed records not wired into download/preview | 4 |
| No migration of existing files | 5 |
| Uploads still land locally regardless of `DEFAULT_STORAGE_PROVIDER` | 6 |
| Google-native export formats defined but no UI reaches them | 8 |
| No `Changes` API polling — a rename in the Drive web UI is invisible here | 9 |

**Until Phase 9 ships, keep Shared Drive membership to the service account and two named
administrators.** There is no synchronization yet, so a file renamed or moved directly in
the Drive web UI silently diverges from what the application believes.

---

## 6. Blockers still open from Phase 0

Neither blocks Phases 3–4, both must be answered before Phase 5 is planned:

- **R1 — Shared Drive item limit (500,000, and it cannot be raised).** Every file *version*
  is an item. Count `FileVersion` + `Folder` documents. Above ~350,000 projected, the design
  has to shard across multiple Shared Drives, which turns `GOOGLE_SHARED_DRIVE_ID` from a
  scalar into a per-department mapping — cheap now, very expensive to retrofit.
- **R2 — folder depth.** Drive allows 20 levels; this application allows 32. Any tree deeper
  than 19 is unmigratable as-is.
