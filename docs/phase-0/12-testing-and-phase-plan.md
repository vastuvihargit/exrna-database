# 12 — Testing Strategy & Phase-wise Task Checklist

## Testing strategy

| Layer | Tool | Runs where | Covers |
|---|---|---|---|
| Unit | Vitest | every commit | path safety, filename sanitization, permission resolution, checksum, DTO mappers, Zod schemas, storage keys, env parsing |
| Integration (DB) | Vitest + `mongodb-memory-server` (replica set) | every commit | repositories, services, transactions, indexes, invariants |
| API | Vitest + `next-test-api-route-handler` (or a booted server + `supertest`) | every commit | status codes, envelopes, auth gates, CSRF, pagination |
| Security | Vitest suite tagged `@security` | every commit + nightly | IDOR, traversal, leakage, escalation, injection (the AC1–AC18 table) |
| E2E | Playwright | pre-merge to main + nightly | the Drive spine end to end, upload→preview→share→review→version |
| Accessibility | `@axe-core/playwright` | with e2e | ten primary screens, zero serious/critical violations |
| Load (smoke) | `autocannon` / `k6` | before production | 2 GB upload, 100 concurrent list requests, large folder pagination |
| Restore drill | scripted, manual trigger | quarterly | backup → restore → checksum verification |

Coverage gates: ≥ 85 % on `src/server/{permissions,storage,services}/**` (the security-critical
core), ≥ 70 % overall. A PR that lowers coverage on the permission or storage layer fails CI.

### Test data

`scripts/seed.ts` builds a deterministic fixture used by integration, security and e2e suites:
2 departments (Molecular Biology, Analytical Chemistry), 2 projects, 3 experiments, 8 users covering
every role, and files at all four confidentiality levels. The security suite is written against
these fixtures so "Dept-B cannot read Dept-A's restricted file" is a literal, repeatable assertion.

### Mandatory tests (brief §21) → suite mapping

| Required proof | Suite | Phase |
|---|---|---|
| One department cannot access another department's restricted files | `security/cross-department.spec.ts` | 3, 5 |
| A user cannot guess a file id and download it | `security/idor.spec.ts` | 5 |
| A user cannot manipulate a file path | `security/path-traversal.spec.ts` | 4 |
| A deactivated user immediately loses access | `security/deactivation.spec.ts` | 2 |
| Search does not expose restricted filenames | `security/search-leakage.spec.ts` | 6 |
| Approved files cannot be silently overwritten | `integration/versioning-approval.spec.ts` | 6, 8 |
| Old versions remain available | `integration/versioning.spec.ts` | 6 |
| Container restarts do not delete files | `e2e/persistence.spec.ts` (compose restart + re-download + checksum) | 1, 4 |
| A failed upload does not create a valid file record | `integration/upload-failure.spec.ts` | 4 |
| Backup files can be restored | `scripts/restore-drill.sh` + `verify-storage-integrity.ts` | 11 |

## Success-criteria traceability

| # | Success criterion (brief §24) | Proven by |
|---|---|---|
| 1 | Only authorized company-email employees can access | `security/auth-domain.spec.ts`, `security/deactivation.spec.ts` |
| 2 | As easy as Google Drive | `e2e/drive-spine.spec.ts` (create→upload→find→preview→share in one flow, no docs), a11y suite |
| 3 | MongoDB stores structured metadata and permissions | integration schema + index tests |
| 4 | Files in private persistent storage | `e2e/persistence.spec.ts`, storage unit tests |
| 5 | No file publicly accessible by physical path | `security/no-public-path.spec.ts` (direct fetch of `/data/...`, `/uploads/...`, `/_next/...` variants) |
| 6 | Find files without knowing the folder | `e2e/search.spec.ts` |
| 7 | Latest approved version identifiable | `integration/versioning-approval.spec.ts` + `e2e/approval-banner.spec.ts` |
| 8 | Previous versions preserved | `integration/versioning.spec.ts` |
| 9 | Every sensitive action auditable | `integration/audit-coverage.spec.ts` — asserts each of the 24 action types is emitted by its service |
| 10 | Unauthorized users cannot discover or download restricted files | `security/*` suite |
| 11 | Files connected to projects and experiments | `integration/research-metadata.spec.ts` |
| 12 | Drive files migrate safely | `integration/migration.spec.ts` with a mocked Drive API (idempotency, dedupe, resume, read-only) |
| 13 | Files survive redeploy/restart | `e2e/persistence.spec.ts` |
| 14 | MongoDB and storage backed up | restore drill + `verify-storage-integrity.ts` |
| 15 | Built and tested phase by phase | this checklist + per-phase acceptance sign-off |

## Phase checklist & acceptance criteria

Legend: ☐ pending · ▣ in progress · ☑ done

### Phase 0 — Requirements & architecture ☑
☑ Requirements, assumptions, MVP/future scope ☑ architecture + layering ☑ ER diagram + 24 collection
schemas ☑ index plan ☑ storage design + provider interface ☑ auth flows ☑ permission matrix
☑ upload/preview/download/versioning sequences ☑ backup architecture ☑ deployment + Docker strategy
☑ API endpoint list ☑ threat model ☑ migration strategy ☑ UI structure ☑ testing strategy
**Acceptance:** verified in [README](./README.md#phase-0-acceptance-criteria--verification).

### Phase 1 — Project foundation
☐ Next.js App Router + TS strict ☐ Tailwind + shadcn + theming ☐ env validation (Zod, fail-fast)
☐ Mongo connection (pooled, hot-reload-safe) ☐ base models + index sync ☐ AppError + route wrapper
☐ Pino logging with redaction ☐ StorageProvider + LocalStorageProvider + path safety
☐ `/api/health`, `/api/health/ready` ☐ AppShell/Sidebar/Header ☐ error + loading + not-found pages
☐ Dockerfile, compose (base/dev/prod), Nginx dev config, volumes ☐ `.env.example` ☐ Vitest + first tests

**Acceptance:** app starts via Compose · Mongo connects · volume mounted and writable · env validated
(bad env → refuses to boot) · file written before an app-container restart is readable after it ·
`/api/health/ready` reports db + storage + disk.

### Phase 2 — Authentication & employee management
☐ Google OAuth ☐ password login (Argon2id) ☐ domain gate ☐ sessions + rotation + CSRF ☐ logout/all
☐ password reset ☐ rate limit + lockout ☐ User/Department/Role/UserRole/Session/LoginHistory models
☐ role seeding (10 roles, 22 permissions) ☐ permission layer + `assertCan` + `visibilityFilter`
☐ activate/deactivate ☐ admin users page ☐ login history ☐ route + API protection ☐ security tests

**Acceptance:** personal emails rejected · deactivated users blocked on the next request · every
protected API 401s without a session · roles load from Mongo · sessions expire and rotate.

### Phase 3 — Drive & folders
☐ Home, My Drive, Department, Project drives ☐ create/nested folders ☐ breadcrumbs from `pathAncestors`
☐ list + grid ☐ rename/move/copy ☐ circular-move guard ☐ recent/starred ☐ soft delete, trash, restore
☐ pagination + sorting ☐ context menu ☐ inheritance ☐ tests

**Acceptance:** operations persist · circular moves 409 · unauthorized folders 404 · restore works ·
inheritance correct · large lists paginate.

### Phase 4 — Upload & storage
☐ authorize/content/chunks/finalize routes ☐ streaming (no buffering) ☐ chunked + resumable
☐ quarantine → promote ☐ MIME sniff + extension + size validation ☐ SHA-256 ☐ UUID names
☐ metadata write in a transaction ☐ progress/retry/cancel UI ☐ drag & drop + folder upload
☐ quota enforcement ☐ failed-upload cleanup + TTL sweeper ☐ audit ☐ tests

**Acceptance:** files outside `public/` · survive restart · unauthorized upload blocked · bad types
rejected · 2 GB upload with flat memory · double finalize → one record · no path in any response.

### Phase 5 — Preview & download
☐ preview router + viewers ☐ Office artifact pipeline in the worker ☐ download route + safe headers
☐ Range requests ☐ view/download history ☐ permission checks ☐ tests

**Acceptance:** guessed URLs fail · every request permission-checked · headers safe · large files
stream · paths private.

### Phase 6 — Metadata, versioning, search
☐ research metadata + templates ☐ categories/tags ☐ version upload/list/download/restore
☐ approved-version resolution ☐ text index + weights ☐ facets + filters ☐ saved searches
☐ permission-filtered search ☐ tests

**Acceptance:** versions never overwritten · approved read-only · restore creates a new version ·
search leaks nothing · files findable without their folder.

### Phase 7 — Sharing & collaboration
☐ share dialog + principals ☐ 6 access levels ☐ inheritance + overrides ☐ revoke ☐ comments + threads
☐ mentions ☐ notifications ☐ activity + access logs ☐ tests

**Acceptance:** revocation immediate · file overrides work · inheritance correct · comments don't
mutate files · no restricted notifications.

### Phase 8 — Review & approval
☐ submit ☐ reviewer assignment ☐ decisions ☐ resubmission ☐ locking ☐ approval history
☐ review inbox ☐ notifications ☐ tests

**Acceptance:** reviews bind to an exact version · approved versions can't be silently replaced ·
every decision audited · no self-approval · post-approval changes create new versions.

### Phase 9 — Research organization
☐ departments/projects/experiments CRUD ☐ folder templates (the 12 folders) ☐ metadata templates
☐ sample/protocol/instrument refs ☐ classifications ☐ project dashboard ☐ related files ☐ tests

**Acceptance:** files traceable to project + experiment · filters work · templates generate ·
still feels like a Drive.

### Phase 10 — Google Drive migration
☐ read-only OAuth ☐ scan ☐ mapping UI ☐ staged batch import ☐ dedupe by `sourceDriveId` + checksum
☐ pause/resume/retry ☐ report + verification sample ☐ audit per item ☐ tests with a mocked Drive API

**Acceptance:** Drive unchanged · hierarchy preserved · duplicates prevented · failures retryable ·
every item audited.

### Phase 11 — Backup, security, production hardening
☐ Mongo + file backups ☐ off-server + encryption ☐ restore runbook + drill ☐ integrity verification
☐ ClamAV ☐ rate limits ☐ CSRF ☐ security headers ☐ full security suite ☐ index review + slow queries
☐ monitoring + disk/backup alerts ☐ CI/CD ☐ prod compose + HTTPS ☐ user & admin docs

**Acceptance:** security suite green · restore tested · files survive deploys · disk monitored ·
environments separated · no secrets in the repo · critical actions audited.

### Phase 12 — Optional advanced
☐ Atlas Search ☐ content extraction ☐ OCR ☐ semantic search ☐ AI assistant ☐ external collaborators
☐ mobile/desktop ☐ S3/MinIO provider ☐ NAS/DR

## Per-phase exit ritual (applies to every phase)

1. List completed work and every file created/modified.
2. Run the full suite; report pass/fail counts and every failure verbatim.
3. Report unresolved issues and known gaps explicitly — never silently.
4. Walk the phase's acceptance criteria one by one and state the evidence.
5. Update `docs/` and `CHANGELOG.md`.
6. Do not start the next phase while a critical failure is open.
7. Re-run earlier phases' tests to prove nothing regressed.
