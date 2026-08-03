# Biotech Research Drive

A secure, company-internal, Google-Drive-like platform for R&D data: upload, organize, preview,
search, share, review, version and audit every research file in one place.

**MongoDB stores metadata. A private server volume stores the bytes. Nothing is public.**

---

## Status

| Phase | Scope | State |
|-------|-------|-------|
| 0 | Requirements & architecture | ✅ Complete — [`docs/phase-0/`](./docs/phase-0/README.md) |
| 1 | Project foundation | ✅ Complete |
| 2 | Authentication & employee management | ✅ Complete |
| 3 | Core drive & folder management | ✅ Complete |
| 4 | Secure file upload & storage | ✅ Complete |
| 5 | Preview & download | ✅ Complete |
| 6 | Metadata, versioning & search | ✅ Complete |
| 7 | Sharing & collaboration | ✅ Complete |
| 8 | Review & approval | ✅ Complete |
| 9 | Research organization | ✅ Complete |
| 10 | Google Drive migration | ✅ Complete |
| 11 | Backup, security & production hardening | ✅ Complete |
| 12 | Optional advanced features | 📋 Not started — deliberately deferred until the core is proven in use |

**369 tests passing.** See the [changelog](./CHANGELOG.md) for what each phase decided and why.

## Quick start (local, without Docker)

```bash
# 1. Node 22+ required
npm install

# 2. Configuration — .env is created for you; edit COMPANY_EMAIL_DOMAINS and secrets
npm run check:env          # validates configuration, prints resolved storage roots

# 3. Create and verify the private storage tree
npm run storage:init

# 4. MongoDB with a replica set (needed for transactions)
#    Docker: docker run -d -p 27017:27017 --name bd-mongo mongo:7 --replSet rs0 --bind_ip_all
#            docker exec bd-mongo mongosh --eval 'rs.initiate()'

# 5. Run
npm run dev                # http://localhost:3000
```

## Quick start (Docker Compose — the supported path)

```bash
cp .env.example .env       # fill in AUTH_SECRET and SESSION_SECRET

# Development: hot reload, Mongo exposed on 27017, nginx on 8080
docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Production
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production up -d
```

`mongo-init` runs `rs.initiate()` once so multi-document transactions work.
Files live on the named volume `app-data` — **not** in the container — so they survive
rebuilds, restarts and redeploys.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` / `build` / `start` | Next.js dev, production build, production server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including the architectural boundary rules |
| `npm test` | Full Vitest suite (unit + integration) |
| `npm run test:coverage` | Coverage, gated on the storage layer |
| `npm run check:env` | Validate configuration without booting the app |
| `npm run storage:init` | Create the storage tree and prove it is writable |
| `npm run verify:storage` | Integrity check — run after every restore and every deploy |
| `npm run monitor` | Every operational check right now; exit code 0/2/3 by severity |
| `npm run review:indexes` | Declared vs built indexes, redundant and unused ones |
| `npm run purge:trash` | Permanently delete trash past its retention window |
| `npm run cleanup:uploads` | Discard abandoned upload sessions |
| `npm run seed` | Seed roles, departments and an initial administrator |
| `npm run seed -- --demo` | The above plus three demo departments and three demo accounts (development only) |
| `npm run drive:drain` | Move queued uploads on to the Google Shared Drive |
| `npm run drive:sync` | Pick up renames, edits and trashing done directly in Drive |
| `npm run drive:check-approvals` | Re-check that each approved document is still the revision that was signed off |

In production these run on a schedule in the `scheduler` container
(`docker/scheduler/crontab`) rather than by hand. The three `drive:*` jobs are no-ops when
`GOOGLE_DRIVE_STORAGE_ENABLED=false`.

Archiving and deleting the local copies retained after a migration is deliberately **not** on
that list. It is an explicit admin action through `POST /api/admin/storage/local-copies` — it
is the only irreversible step in the migration, and it does not belong on a timer.

## Architecture in one screen

```
Browser ── nginx ── Next.js (route handlers)
                       │
        ┌──────────────┼───────────────┐
        │              │               │
   validation     permission        service
        │              │               │
        └──────────────┴──────► repository ──► MongoDB   (metadata, ACLs, audit)
                                storage    ──► /data      (file bytes, private)
```

Strict rules, enforced by ESLint **and** by tests in `tests/unit/architecture-boundaries.test.ts`:

1. UI components never import the database, the filesystem, or the storage layer.
2. `src/server/**` imports nothing from `next`/`react` (except `src/server/http/**`), so the
   backend can be lifted into NestJS later without a rewrite.
3. Only `src/server/storage/**` touches `fs`.

## Security invariants

These are non-negotiable and each has a test:

- Files are stored outside `public/`; the environment validator **refuses to boot** if a storage
  root resolves inside a served directory.
- Physical paths never appear in a response body, header, or log line.
- Every storage key passes an allow-list validator plus a resolved-prefix containment check —
  traversal payloads (`..`, `%2e%2e`, absolute paths, UNC, NUL) are rejected.
- Stored versions are immutable: files are created with an exclusive `wx` open and never overwritten.
- User-supplied filenames are sanitized for display only; physical names are generated UUIDs.
- SHA-256 and byte count are measured **while streaming**, never taken from the client.
- Uploads that fail, are truncated, or exceed their declared size leave no file behind.

## Layout

```
docs/phase-0/          Architecture: data model, storage, permissions, threat model, deployment
src/app/               App Router: (drive) shell, api/ route handlers
src/components/        ui/ primitives, layout/ shell, providers/
src/hooks/             TanStack Query hooks — the only place fetch() is called
src/server/
  config/              Zod environment validation (fail-fast)
  db/                  Mongoose connection, base schema, models
  errors/              Typed AppError hierarchy
  health/              Readiness reporting
  http/                Next.js ⇄ domain boundary (response envelope, route wrapper)
  logging/             Pino with redaction
  monitoring/          Alert dispatch with cooldown, escalation and recovery
  permissions/         Actor, authorization, visibility filters
  repositories/        All MongoDB access
  security/            Malware scanning
  services/            Business logic — the only layer that composes the others
  storage/             StorageProvider abstraction + LocalStorageProvider + path safety
  validation/          Zod schemas for every request shape
docker/                nginx configs, backup jobs, scheduler
scripts/               check-env, init-storage, verify-storage-integrity, monitor,
                       review-indexes, purge-trash, cleanup-uploads, seed
tests/                 unit/, integration/, security/
.github/workflows/     CI and deploy
```

## Production

The `prod` compose file runs six services: nginx, the app, MongoDB, **ClamAV** (upload
scanning), **scheduler** (health monitoring, integrity sweeps, retention) and **backup**
(encrypted off-server backups and weekly restore drills).

The backup container mounts the file volume **read-only** and reports through a small
status volume that is read-only to the application — so nothing in the application can
damage what protects it. Admin → System shows what that reporting says.

## Documentation

| Audience | Document |
|----------|----------|
| Employees | [Using the Research Drive](./docs/employee-guide.md) |
| Administrators | [Administrator guide](./docs/admin-guide.md) |
| Operators | [Runbook](./docs/operations/runbook.md) · [Backup and restore](./docs/operations/backup-and-restore.md) |
| Security review | [Hardening](./docs/security/hardening.md) · [Threat model](./docs/phase-0/08-security-threat-model.md) |
| Architecture | [`docs/phase-0/`](./docs/phase-0/README.md) — the design contract |

The design documents are the contract; [`CHANGELOG.md`](./CHANGELOG.md) records what each
phase actually decided, including where it departed from the plan and why.
