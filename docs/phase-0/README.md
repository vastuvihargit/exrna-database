# Phase 0 — Requirement Analysis & Architecture

**Project:** Biotech Research Drive (internal, company-only)
**Status:** Phase 0 complete — no production code written in this phase.
**Date:** 2026-07-28

This directory is the complete Phase 0 deliverable. It is the contract that Phases 1–12
implement against. Nothing here is code; everything here is binding design.

| # | Document | Covers (from the brief's §23 checklist) |
|---|----------|----------------------------------------|
| 01 | [Requirements & Scope](./01-requirements-and-scope.md) | 1. Business summary, 2. Assumptions, 3. MVP scope, 4. Future scope |
| 02 | [System Architecture](./02-architecture.md) | 5. Complete system architecture, layering rules, NestJS extraction path |
| 03 | [Data Model](./03-data-model.md) | 6. Collection diagram, 7. Collection schemas, 8. Indexing strategy |
| 04 | [Storage Design](./04-storage.md) | 9. Local-storage directory architecture, 10. StorageProvider abstraction |
| 05 | [Auth & Permissions](./05-auth-and-permissions.md) | 11. Authentication flow, 12. Permission matrix |
| 06 | [Core Flows](./06-flows.md) | 13. Upload, 14. Preview, 15. Download, 16. Versioning sequences |
| 07 | [API Surface](./07-api.md) | 19. API endpoint list |
| 08 | [Security Threat Model](./08-security-threat-model.md) | 20. Threat model (STRIDE + abuse cases) |
| 09 | [Deployment & Backup](./09-deployment-and-backup.md) | 17. Backup architecture, 18. Deployment, 25. Docker strategy |
| 10 | [Google Drive Migration](./10-google-drive-migration.md) | 21. Migration strategy |
| 11 | [UI Structure](./11-ui-structure.md) | 22. Page & component structure, wireframe descriptions |
| 12 | [Testing & Phase Plan](./12-testing-and-phase-plan.md) | 23. Phase checklist, 24. Per-phase acceptance criteria, testing strategy |

## Phase 0 acceptance criteria — verification

| Criterion | Where satisfied | Status |
|---|---|---|
| Database and storage responsibilities are clearly separated | [02](./02-architecture.md#responsibility-split), [04](./04-storage.md) | ✅ MongoDB stores metadata only; disk stores bytes only; the join key is `storageKey` |
| File binaries are not stored in MongoDB | [03](./03-data-model.md), [04](./04-storage.md) | ✅ No Buffer/Base64/GridFS field exists in any schema |
| Local files are outside the public directory | [04](./04-storage.md#hard-rules) | ✅ `/data/*` volumes, never `public/`; enforced by a startup assertion |
| Authentication and permission flow is documented | [05](./05-auth-and-permissions.md) | ✅ Flow diagrams + full permission matrix + resolution algorithm |
| Backup requirements are defined | [09](./09-deployment-and-backup.md#backup-architecture) | ✅ RPO/RTO, schedule, off-server target, encryption, verification, restore drill |
| MVP and future features are separated | [01](./01-requirements-and-scope.md#mvp-scope) | ✅ Explicit in-scope / out-of-scope / deferred tables |

## Reading order for a new engineer

01 → 02 → 03 → 04 → 05 → 06. Everything else is reference.
