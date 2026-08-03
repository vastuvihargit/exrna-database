# 01 — Requirements, Assumptions & Scope

## 1. Business requirement summary

The company's R&D data currently lives in Google Drive. Drive is good at storing files and bad
at everything the research organization actually needs from those files: knowing which version is
the approved one, knowing which experiment a spectrum belongs to, knowing who downloaded a
confidential protocol, and finding a 2023 assay result without knowing which folder someone put it in.

The ten stated pain points reduce to **five root causes**:

| # | Root cause | Symptoms it produces | How this platform fixes it |
|---|-----------|----------------------|----------------------------|
| R1 | **Location is the only index.** A file is findable only if you know its folder. | "Can't find the file", "don't know where it's stored", "hard to search old data" | Metadata-first model: every file carries project / experiment / sample / category / tags. Search is the primary navigation, folders are secondary. |
| R2 | **No identity for a document across time.** Each upload is a new, unrelated file. | Duplicates, "which is the latest?", `final_v3_FINAL_real.xlsx` | A **logical file** with an ordered chain of **immutable versions**; exactly one `currentVersion`, at most one `approvedVersion`. |
| R3 | **No provenance.** Drive's activity log is shallow and not exportable per-record. | "Who downloaded this?", "who approved this?" | Append-only audit log on every sensitive action, with actor, IP, user-agent, before/after values, request ID. |
| R4 | **Permissions are ad hoc and per-file.** | Confidential R&D leaks; over-sharing; "anyone with link" | Hierarchical RBAC + ABAC: role × scope (company → department → project → folder → file), evaluated server-side on every request, plus a `confidentiality` classification. |
| R5 | **No structural link between data and science.** | "No connection between files, projects, experiments, samples, results" | First-class `Project` and `Experiment` collections; files reference them; templated project folder trees enforce naming consistency. |

**The workflow that must stay Google-Drive-simple:**

```
Create folder → Upload files → Organize → Search → Preview → Share → Review → Track versions
```

Everything biotech-specific is *additive metadata and workflow* layered on that spine. If a
feature makes the spine harder to use, it does not belong in the MVP. **This is a Drive, not a LIMS.**

### Non-negotiable constraints (from the brief)

1. Files live on a **private server filesystem**, never in MongoDB, never in `public/`, never in browser storage.
2. Every byte served passes through an authenticated, permission-checked backend route.
3. Physical paths are never emitted to a client.
4. Versions are immutable; approved versions are read-only.
5. Company-email-only access; no public registration; no public share links.
6. Deployment target is a persistent-disk VPS with Docker — **not** a serverless platform.

> **Deployment note.** The brief explicitly rules out Vercel/Netlify serverless filesystems for
> file storage, and that judgement is correct for this design: the local-disk StorageProvider needs
> a persistent mount. The recommended target is an Ubuntu VPS with Docker Compose (see
> [09](./09-deployment-and-backup.md)). A managed platform only becomes viable after the optional
> Phase 12 migration to S3/MinIO/R2 behind the same `StorageProvider` interface.

## 2. Assumptions

Recorded explicitly because they shape the schema. Each is cheap to revisit if wrong.

### Organizational
| ID | Assumption | Impact if wrong |
|----|-----------|-----------------|
| A1 | Single company / single tenant, but every document carries `organizationId` for future multi-tenancy and to match the prescribed storage path. | Low — the field already exists. |
| A2 | Headcount is 50–500 employees; concurrent users < 100. | Sizing only; architecture unchanged to ~5k users. |
| A3 | Total corpus 1–20 TB, individual files up to 2 GB (`MAX_UPLOAD_SIZE_MB=2048`), with instrument raw data being the large tail. | Storage sizing, chunk tuning. |
| A4 | A user belongs to exactly **one** primary department, and may be a member of **many** projects. | If users need multiple departments, `departmentId` becomes `departmentIds[]` — contained change. |
| A5 | Approval is single-reviewer-per-decision but a file may require N approvals; MVP ships single-approver, schema supports N. | Schema already stores an approvals array. |
| A6 | Company email domains are known and stable; identity comes from Google Workspace for most staff. | Config only. |

### Technical
| ID | Assumption | Impact if wrong |
|----|-----------|-----------------|
| A7 | MongoDB runs as a **replica set** (even single-node `rs0`) so multi-document transactions are available. | Without it, transactions must be replaced by compensating writes. This is why compose configures a replica set from day one. |
| A8 | The Next.js app runs as a **long-lived Node server** (`output: 'standalone'`), not serverless — so streams, background jobs and disk handles are legal. | Fundamental. Non-negotiable. |
| A9 | One application node in the MVP. Storage is a local mount, so horizontal scale requires shared storage (NFS) or the S3 provider. | Documented as a Phase 12 concern. |
| A10 | Virus scanning is an integration point (ClamAV) wired in Phase 11; before that, quarantine + type allow-listing is the control. | Quarantine flow already exists, so ClamAV is a drop-in. |
| A11 | Office previews (DOCX/XLSX/PPTX) are rendered **server-side to PDF/HTML artifacts** or client-side with sandboxed parsers — never by executing the document. | Preview quality only. |
| A12 | Full-text search of *file contents* is out of MVP scope; MVP searches metadata + filenames via MongoDB text indexes. | Stated in brief §12. |
| A13 | Time is stored UTC; display is browser-local. | Trivial. |

### Product
| ID | Assumption |
|----|-----------|
| A14 | Real-time collaborative *editing* of documents is not required. The unit of change is a new version. |
| A15 | Trash retention 30 days, then a purge job hard-deletes bytes. Audit rows for the deletion survive forever. |
| A16 | External collaborators are explicitly out of the MVP (brief §6). No `isExternal` flows are built, but the `User` model reserves the field. |
| A17 | Notifications are in-app first; email (SMTP) is best-effort and never a permission gate. |

## 3. MVP scope

"MVP" = Phases 1–9 + the security/backup hardening of Phase 11 that is required to run on real data.

### In scope

**Identity & access**
- Company-email-only sign-in: Google Workspace OAuth **and** email+password (Argon2id), both domain-gated.
- No public registration. `ALLOW_AUTO_PROVISIONING=false` by default → admin must invite/approve.
- Sessions: HTTP-only, `SameSite=Lax`, rotating, server-side session records revocable instantly.
- Login rate limiting, failed-login lockout, login/device history, CSRF protection.
- 10 default roles, 22 permissions, 5 scopes; admin can create custom roles.
- Immediate deactivation kills all sessions.

**Drive core**
- Home, My Drive, Department Drives, Project Drives, Shared with Me, Recent, Starred, Pending Reviews, Approved, Archive, Trash, Admin.
- Folder create/nest/rename/move/copy; circular-move prevention; soft delete + restore.
- Multi-file and folder upload, drag & drop, streaming + chunked/resumable upload, progress, retry.
- List & grid views, breadcrumbs, context menu, details panel, sorting, pagination, storage usage.
- Light/dark, responsive, loading/empty/error/permission-denied states.

**Files**
- Quarantine-then-promote upload pipeline, SHA-256, MIME sniffing + extension allow-list, size and quota enforcement.
- Immutable versions, version notes, version history, download old versions, restore-as-new-version.
- Preview: PDF, images, text, CSV, JSON, XML, source code, audio, video (Range requests). Office via generated artifacts.
- Download with safe `Content-Disposition`, streamed, fully audited.

**Research organization**
- Departments, Projects, Experiments; project folder templates (the 12 prescribed folders); metadata templates by department/type.
- File metadata: sample IDs, protocol, instrument, organism, batch/lot, research date, category, data type, tags, confidentiality.
- Project dashboard; filter by project / experiment / sample / researcher / department.

**Collaboration & governance**
- Internal sharing with users, departments, projects, roles at 6 access levels. **No public links.**
- Folder→file permission inheritance with per-file overrides; instant revocation.
- Threaded comments with @mentions; notifications.
- Review workflow: Draft → Submitted → Changes Requested → Approved → Final → Archived, bound to a specific version; approved versions locked.
- Append-only audit log across all 24 listed action types; admin-only audit viewer.

**Operations**
- Docker Compose (app + MongoDB replica set + Nginx + worker + backup), persistent volumes.
- Health check reporting DB + storage + disk headroom.
- Daily Mongo dump, daily incremental + weekly full file backup, encrypted, off-server copy, verified restore.
- Google Drive migration: scan, map, import, dedupe by checksum, pause/resume, retry, report — read-only against Drive.

### Explicitly NOT in the MVP

| Excluded | Reason |
|---|---|
| Public / "anyone with the link" sharing | Brief §14 forbids it. |
| External collaborator accounts | Brief §6 defers it. |
| In-browser document editing / co-editing | A14; not a Drive-spine feature. |
| Full-text search of file *contents*, OCR, semantic/AI search | Brief §12 defers to Atlas Search phase. |
| Desktop sync client, mobile app | Phase 12. |
| E-signature / 21 CFR Part 11 formal compliance | Not requested. The audit + immutable-version design is compatible with a later compliance project; do not claim compliance. |
| Instrument/LIMS integrations, sample inventory, plate maps, chain-of-custody | Would turn the product into a LIMS. Explicitly forbidden. |
| Multi-region / multi-node storage | A9. |

## 4. Future scope (post-MVP, Phase 12+)

Ordered by expected value per unit of risk:

1. **Content-aware search** — text extraction (PDF/DOCX/XLSX), MongoDB Atlas Search, then embeddings + semantic search, then a retrieval-grounded research assistant. Requires the permission filter to be applied *before* ranking, never after.
2. **Object storage** — MinIO / S3 / R2 `StorageProvider`, unlocking horizontal scale and managed hosting. The interface in [04](./04-storage.md) exists precisely for this.
3. **Antivirus automation** — ClamAV/ICAP inline in the quarantine step, with automatic rejection.
4. **External collaborator access** — time-boxed, watermarked, download-disabled, per-file grants.
5. **Compliance pack** — e-signatures, reason-for-change prompts, validated backups, retention policies.
6. **Desktop sync + mobile app**.
7. **DR** — warm standby server, storage replication, documented failover.
8. **Analytics** — project data-completeness dashboards, storage forecasting, review-cycle-time metrics.

## 5. Definition of done for the whole programme

The 15 success criteria in brief §24 map 1:1 to tests listed in
[12 — Testing & Phase Plan](./12-testing-and-phase-plan.md#success-criteria-traceability).
No criterion is considered met without an automated test proving it.
