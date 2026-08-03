# 07 — API Endpoint Surface

All routes are Next.js Route Handlers under `src/app/api/**`. Every route: validates the session,
validates input with Zod, calls `assertCan()`, delegates to a service, and returns
`{data}` / `{error}`. Phase column shows when the route ships.

## Conventions

- `401 UNAUTHENTICATED` — no/expired/revoked session, or the user is not `active`.
- `403 FORBIDDEN` — authenticated, visible resource, insufficient permission.
- `404 NOT_FOUND` — resource missing **or invisible to this actor** (deliberate ambiguity).
- `409 CONFLICT` — invariant violation (name clash, version moved, circular move).
- `413` size, `415` type, `422` validation, `429` rate limit, `507 QUOTA_EXCEEDED`.
- Non-GET requires `X-CSRF-Token`.
- List endpoints accept `?cursor|page&pageSize&sort&order` and permission-filter at query time.

## Auth & session — Phase 2

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auth/providers` | Which sign-in methods are enabled |
| GET | `/api/auth/google` | Start Google Workspace OAuth (state + PKCE) |
| GET | `/api/auth/callback/google` | OAuth callback → session |
| GET | `/api/auth/microsoft` · `/api/auth/callback/microsoft` | Entra ID (optional) |
| POST | `/api/auth/login` | Email + password (domain-gated, rate-limited) |
| POST | `/api/auth/mfa/verify` | Complete an MFA challenge |
| POST | `/api/auth/logout` | Revoke current session |
| POST | `/api/auth/logout-all` | Revoke every session for the user |
| GET | `/api/auth/session` | Current actor: user, roles, permissions, quota |
| POST | `/api/auth/forgot-password` · `/api/auth/reset-password` | Reset flow |
| POST | `/api/auth/change-password` | Rotates all sessions |
| GET | `/api/auth/sessions` · DELETE `/api/auth/sessions/{id}` | Device list / revoke |
| GET | `/api/auth/login-history` | Own login history |
| GET/POST | `/api/auth/mfa/setup` · `/api/auth/mfa/disable` | Optional MFA |

## Users, departments, projects, experiments — Phase 2 / 9

| Method | Path | Notes |
|---|---|---|
| GET | `/api/users` | Directory; search; admin sees status fields |
| GET/PATCH | `/api/users/{id}` | Profile; PATCH self or `user.manage` |
| POST | `/api/admin/users` | Create/invite (no public registration) |
| POST | `/api/admin/users/{id}/activate` · `/deactivate` | Deactivate revokes all sessions immediately |
| POST/DELETE | `/api/admin/users/{id}/roles` | Grant/revoke role at a scope; rank-checked |
| PATCH | `/api/admin/users/{id}/quota` · `/department` | |
| GET/POST | `/api/departments` · GET/PATCH/DELETE `/api/departments/{id}` | |
| GET | `/api/departments/{id}/members` · `/storage` | |
| GET/POST | `/api/projects` · GET/PATCH/DELETE `/api/projects/{id}` | Create optionally applies a folder template |
| GET/POST/DELETE | `/api/projects/{id}/members` | |
| GET | `/api/projects/{id}/dashboard` | Counts, recent files, review queue, storage |
| GET/POST | `/api/experiments` · GET/PATCH/DELETE `/api/experiments/{id}` | Filter by project |
| GET | `/api/experiments/{id}/files` | |

## Folders — Phase 3

| Method | Path | Notes |
|---|---|---|
| GET | `/api/folders` | `?driveType&departmentId&projectId&parentFolderId` |
| POST | `/api/folders` | 409 on duplicate name in the same parent |
| GET | `/api/folders/{id}` | Metadata + effective permissions for the actor |
| GET | `/api/folders/{id}/children` | Paginated folders + files, sortable |
| GET | `/api/folders/{id}/breadcrumbs` | From `pathAncestors`, permission-trimmed |
| PATCH | `/api/folders/{id}` | Rename / edit description |
| POST | `/api/folders/{id}/move` | 409 `CIRCULAR_MOVE` if target ∈ subtree; rewrites `pathAncestors` |
| POST | `/api/folders/{id}/copy` | Async job when the subtree is large |
| POST | `/api/folders/{id}/star` · DELETE | Per-user |
| DELETE | `/api/folders/{id}` | Soft delete → Trash (cascades to subtree) |
| POST | `/api/folders/{id}/restore` | Restores to `trashedFromParentId`, or to root if it's gone |
| POST | `/api/folders/{id}/archive` | |
| GET | `/api/folders/{id}/activity` | Timeline |
| POST | `/api/folders/from-template` | Instantiate a folder template into a project/department |

## Uploads — Phase 4

| Method | Path | Notes |
|---|---|---|
| POST | `/api/uploads/authorize` | Permission + type + size + quota; creates the session |
| PUT | `/api/uploads/{id}/content` | Single-shot streamed body |
| PUT | `/api/uploads/{id}/chunks/{index}` | Chunked; idempotent per index |
| GET | `/api/uploads/{id}` | Resume info: received chunks, bytes |
| POST | `/api/uploads/{id}/finalize` | Idempotent; returns `{file, version}` |
| DELETE | `/api/uploads/{id}` | Abort; deletes quarantine/temp |
| GET | `/api/uploads` | Own in-flight/failed sessions |

`route.ts` for the streaming routes sets `export const runtime = 'nodejs'`,
`export const dynamic = 'force-dynamic'`, and consumes `request.body` as a web stream converted with
`Readable.fromWeb` — the body is never `await request.arrayBuffer()`'d (that would defeat streaming).

## Files & versions — Phases 4–6

| Method | Path | Notes |
|---|---|---|
| GET | `/api/files` | Filter: folder, project, experiment, category, tags, status, confidentiality, dates, sample |
| GET | `/api/files/{id}` | Metadata + current/approved version + effective permissions |
| PATCH | `/api/files/{id}` | Rename, edit research metadata; blocked while `isLocked` for approved-version edits |
| POST | `/api/files/{id}/move` · `/copy` · `/star` · `/archive` · `/restore` | |
| DELETE | `/api/files/{id}` | Soft delete → Trash |
| **GET** | **`/api/files/{id}/preview`** | `?versionId` — streams original or artifact |
| **GET** | **`/api/files/{id}/download`** | `?versionId` or `?approved=1` — streams, audited |
| GET | `/api/files/{id}/versions` | History, newest first |
| POST | `/api/files/{id}/versions` | Starts a new-version upload session |
| GET | `/api/files/{id}/versions/{versionId}` | |
| POST | `/api/files/{id}/versions/{versionId}/restore` | Creates a new version |
| GET | `/api/files/{id}/activity` · `/access-log` | Views/downloads; `access-log` needs `audit.view` or ownership |
| GET/POST | `/api/files/{id}/comments` · PATCH/DELETE `/api/comments/{id}` · POST `/api/comments/{id}/resolve` | Threaded, mentions |
| GET/POST | `/api/files/{id}/shares` · PATCH/DELETE `/api/shares/{id}` | Internal only — no public link endpoint exists |
| GET | `/api/files/{id}/effective-permissions` | For the share dialog |

## Search & views — Phase 6

| Method | Path | Notes |
|---|---|---|
| GET | `/api/search` | `q` + facets; Mongo `$text` with weights; **permission filter in the query** |
| GET | `/api/search/suggest` | Prefix suggestions, anchored regex, capped, index-backed |
| GET/POST/DELETE | `/api/search/saved` | Saved searches |
| GET | `/api/drive/recent` · `/starred` · `/shared-with-me` · `/trash` · `/archive` | |
| GET | `/api/drive/pending-reviews` · `/approved` | |
| GET | `/api/drive/storage-usage` | Actor + department + project |

## Review & approval — Phase 8

| Method | Path |
|---|---|
| POST `/api/files/{id}/review` (submit) · GET `/api/reviews` (inbox) · GET `/api/reviews/{id}` |
| POST `/api/reviews/{id}/decision` (`approved` / `rejected` / `changes_requested`) |
| POST `/api/reviews/{id}/cancel` · `/reassign` |
| GET `/api/files/{id}/approval-history` |

## Notifications — Phase 7

`GET /api/notifications` · `POST /api/notifications/{id}/read` · `POST /api/notifications/read-all` ·
`GET /api/notifications/unread-count`

## Admin — Phases 2, 9, 11

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/audit-logs` | Filter by actor/action/entity/date; `audit.view` only; **read-only, no write route exists** |
| GET | `/api/admin/audit-logs/export` | CSV export — itself audited |
| GET | `/api/admin/login-history` | |
| GET/POST/PATCH/DELETE | `/api/admin/roles` | Custom roles |
| GET/POST/PATCH/DELETE | `/api/admin/folder-templates` · `/api/admin/metadata-templates` | |
| GET/PATCH | `/api/admin/settings` | Upload limits, allowed types, quotas, retention |
| GET | `/api/admin/storage` | Usage by user/department/project + disk headroom |
| GET | `/api/admin/uploads/failed` · POST `/api/admin/uploads/{id}/retry` | |
| GET | `/api/admin/quarantine` · POST `/api/admin/quarantine/{id}/release` · `/reject` | |
| GET | `/api/admin/backups` · POST `/api/admin/backups/run` · `/verify` | |
| GET | `/api/admin/health` · `/api/admin/jobs` · POST `/api/admin/jobs/{id}/retry` | |
| GET | `/api/admin/trash` · POST `/api/admin/trash/{id}/restore` · `/purge` | Purge requires `reason` |

## Migration — Phase 10

`GET/POST /api/admin/migrations` · `GET /api/admin/migrations/{id}` ·
`POST /api/admin/migrations/{id}/connect|scan|map|start|pause|resume|cancel|retry-failed` ·
`GET /api/admin/migrations/{id}/items|report` · `GET /api/admin/migrations/google/folders`

## System — Phase 1

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Public, unauthenticated, no internals: `{status, uptime}` |
| GET | `/api/health/ready` | DB ping + storage writability + disk headroom; 503 when unhealthy |
| GET | `/api/version` | Build SHA, environment name |

## Route-level guarantees checked by tests

1. Every route under `/api/**` except `health`, `version`, and `auth/*` returns 401 without a session.
2. Every mutating route returns 403 without a CSRF token.
3. No response body of any route contains `storageKey`, `relativeStoragePath`, `passwordHash`,
   `tokenHash`, or a string matching `^/(data|var|home)/`.
4. Every route that returns a resource by id returns 404 (not 403) when the actor lacks visibility.
