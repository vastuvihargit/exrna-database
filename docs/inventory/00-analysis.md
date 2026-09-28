# Inventory Management — Phase 0 analysis

Status: **implemented.** This was the Phase 0 analysis; the module now exists on both engines.
What was built, and where it diverges from this analysis:

* Items, batches and the append-only stock ledger — MongoDB and D1
  (`docs/cloudflare-migration/18-phase-3-module-15-inventory.md`), with the stock UI (receive,
  issue, adjust, history, overview).
* **Expiry sweep, scheduled.** `stockService.sweepExpired` writes expired batches off (one
  `expired` ledger row each, idempotent — a second run writes nothing, and overlapping runs write
  each batch off once). It runs daily: `npm run inventory:expire` from the Node scheduler
  (`docker/scheduler/crontab`, 03:20), and on the Cloudflare Worker from the `7 * * * *` cron at
  03:07 UTC through the maintenance queue (`src/server/queues/schedule.ts`). Scoped to the
  deployment's organization, resolved server-side; each automatic run that writes anything leaves
  a system audit record.
* Tests: `tests/d1/inventory-repository.test.ts` (both engines, stock integration and the
  overlapping-sweep case), `tests/security/inventory-permissions.test.ts` (who may move stock,
  the sweep's scope and idempotency), `e2e/20-inventory.spec.ts` (the UI).
* **Not built:** the stock-request workflow (§9, deferred — see the end of this document). It is not required for the
  current release.

The Research Drive is a mature, strictly layered application (validation → permission →
service → repository → MongoDB / storage). This module is added *inside* those layers, not
beside them. Nothing in `src/server/storage/**`, the upload/download path, or the Google
Drive backend is touched.

---

## 1. What the existing project gives us

| Concern | Existing mechanism | Reused as-is |
|---|---|---|
| Request wrapping, request-id, error mapping | `withRouteHandler` | ✅ |
| Auth + CSRF + rate limit | `withAuthenticatedRoute` → `Actor` | ✅ |
| Response envelope | `ok()`, `created()`, `noContent()` | ✅ |
| Input validation | Zod schemas in `src/server/validation/` | ✅ new file |
| Permission vocabulary | `src/server/domain/permissions.ts` (`PERMISSIONS`) | extended |
| Roles as data | `Role`/`UserRole` collections, seeded from `DEFAULT_ROLES` | extended |
| Company-scope permission check | `assertCompanyPermission` | pattern mirrored |
| Audit trail | `auditService.recordForActor` / `recordSystem` | ✅ |
| Soft delete + timestamps + hidden fields | `baseSchemaOptions`, `softDeleteFields`, `applySoftDeleteFilter` | ✅ |
| Transactions | `withTransaction` (replica set already required) | ✅ |
| DTO shaping | `src/server/http/dto.ts` | extended |
| Page guard | `requireActor`, `redirect('/access-denied')` | ✅ |
| Data fetching | TanStack Query hooks + `apiRequest` (CSRF double-submit) | ✅ new hook |
| UI primitives | `src/components/ui/*` (card, table, dialog, select, input, badge, skeleton, alert-dialog) | ✅ |
| File attachments | existing `File` collection + Drive/local storage provider | ✅ by reference only |

Everything the module needs already exists. The new code is one domain module, two
collections, one service, one repository pair, twelve routes and one UI area.

---

## 2. MongoDB schema

Two new collections, as specified. `users`, `departments`, `projects`, `experiments`,
`files` and `auditLogs` are referenced, never duplicated.

### 2.1 `inventoryItems`

```
organizationId      ObjectId → Organization      required
departmentId        ObjectId → Department        default null   // null = central store
name                String   required            max 200
code                String   required, uppercase  unique per organization
category            enum  chemical | reagent | consumable | glassware | equipment | other
unit                enum  mg | g | kg | µL | mL | L | units | vials | boxes | packs | rolls | other
availableQuantity   Number   min 0                // maintained = Σ batches[].quantity
minimumStock        Number   min 0
stockState          enum  ok | low | out_of_stock // derived on every write, indexable
batches             [ Batch ]                     // the ledger of what is physically there
batchNumber         String                        // derived: earliest-expiring open batch
expiryDate          Date | null                   // derived: earliest expiry among open batches
storageLocation     String   max 120              // default location for this item
supplier            String   max 200              // default / most recent supplier
description         String   max 4000
status              enum  active | inactive | discontinued
documentFileIds     [ObjectId → File]             // CoA / MSDS — existing Drive files only
createdBy / updatedBy, deletedAt / deletedBy (softDeleteFields)
```

`Batch` subdocument:

```
batchNumber     String  required  max 80
quantity        Number  min 0
expiryDate      Date | null
supplier        String
storageLocation String
receivedAt      Date
receivedBy      ObjectId → User
receiptTxnId    ObjectId → StockTransaction     // the row that created this batch
```

**Why batches are embedded rather than a third collection.** "Expired stock must not be
issued" is unanswerable from a single scalar quantity — you cannot tell how much of 500 g
expired last week. Per-batch quantities are therefore required by the brief itself. Keeping
them *inside the item document* means the availability check and the decrement happen in one
atomic document update, which is what makes negative stock structurally impossible (§4). A
separate `stockBatches` collection would need a transaction for every read-modify-write and
would add a third collection the brief did not ask for. The cost is a bounded array: batches
are capped (500) and fully-consumed batches older than the retention window are pruned by the
same sweep that flags expiry — their history survives in `stockTransactions`, which is the
permanent record.

`availableQuantity`, `stockState`, `batchNumber` and `expiryDate` are **derived** and
recomputed from `batches` in the same update that changes them. They exist so the list,
filter and alert queries are indexable; they are never the source of truth. A Phase 4 test
asserts they agree with the batch sum after every operation.

Indexes:

```
{ organizationId, code }                        unique
{ organizationId, status, category }
{ organizationId, departmentId, status }
{ organizationId, stockState }                  // low / out-of-stock filters
{ organizationId, expiryDate }                  // near-expiry / expired ranges
{ organizationId, 'batches.expiryDate' }        // expiry sweep
text: name, code, supplier, storageLocation, description, batches.batchNumber
      weights: code 10, name 8, batches.batchNumber 6, supplier 4, storageLocation 3, description 1
```

`stockState` is a stored enum rather than a query-time `$expr` comparison of
`availableQuantity` against `minimumStock`, because `$expr` cannot use an index and the
low-stock filter is on the dashboard's hot path.

### 2.2 `stockTransactions`

One collection serves both "stock transaction" and "stock history" — they are the same rows
read two ways.

```
organizationId    ObjectId → Organization
itemId            ObjectId → InventoryItem
itemCode          String        // denormalized so history renders without a join
itemName          String
departmentId      ObjectId → Department | null

action            enum  added | issued | returned | adjusted | expired
quantity          Number  > 0                 // magnitude, as entered
quantityDelta     Number                      // signed: +added/+returned, −issued/−expired, ± adjusted
previousQuantity  Number                      // item availableQuantity before
newQuantity       Number                      // item availableQuantity after
unit              String

batchNumber       String
expiryDate        Date | null
supplier          String                      // added / returned
storageLocation   String

issuedToType      enum  employee | department | project | experiment | null
issuedToUserId        ObjectId → User        | null
issuedToDepartmentId  ObjectId → Department  | null
projectId             ObjectId → Project     | null
experimentId          ObjectId → Experiment  | null

purpose           String  max 500
notes             String  max 2000
documentFileIds   [ObjectId → File]

performedBy       ObjectId → User  required   // receivedBy / issuedBy / adjustedBy
performedAt       Date  required              // receivedDate / issueDate, defaults to now
requestId         String                      // ties a row to its audit-log entry
createdAt         (timestamps: createdAt only)
```

**Immutability.** `stockTransactions` copies the enforcement pattern of
`audit-log.model.ts` exactly:

1. the repository exposes only `append()` and query functions — no update, no delete;
2. Mongoose `pre` hooks reject `updateOne`, `updateMany`, `findOneAndUpdate`, `replaceOne`,
   `deleteOne`, `deleteMany`, `findOneAndDelete`, and re-`save` of a non-new document;
3. no API route exists that could reach an update or delete — the absence is the control.

There are no soft-delete fields, because nothing may be deleted. A mistaken entry is
corrected by a compensating `adjusted` row, which is exactly how a stock ledger is supposed
to work and leaves the correction visible.

Indexes:

```
{ organizationId, createdAt: -1 }
{ itemId, createdAt: -1 }
{ organizationId, action, createdAt: -1 }
{ performedBy, createdAt: -1 }
{ projectId, createdAt: -1 }        sparse
{ experimentId, createdAt: -1 }     sparse
{ issuedToUserId, createdAt: -1 }   sparse
{ organizationId, batchNumber }
```

### 2.3 Attachments

`documentFileIds` holds ids of rows in the **existing** `files` collection. Certificates of
analysis, MSDS sheets and delivery notes are uploaded through the normal drive UI and then
linked. Inventory never writes bytes, never calls a `StorageProvider`, and never touches the
Google Drive backend. Resolving a linked document goes through the existing file service, so
its permissions apply unchanged: a linked file the reader cannot open simply is not listed.

---

## 3. Permission plan

### 3.1 New permission strings

Added to `PERMISSIONS` in `src/server/domain/permissions.ts` — the file's own header says
this is the single place a permission is declared, and `Role.permissions` takes its enum from
it, so the addition is backward compatible.

| Permission | Meaning |
|---|---|
| `inventory.view` | See items, batches, alerts, dashboard and history |
| `inventory.item.manage` | Create, edit, deactivate an item definition |
| `inventory.stock.add` | Record a receipt |
| `inventory.stock.issue` | Issue stock to a person, department, project or experiment |
| `inventory.stock.adjust` | Corrections, returns, expiry write-offs |
| `inventory.request` | Raise a request for an item (see §9, deferred) |

### 3.2 Role matrix

| Brief role | Implementation | Permissions |
|---|---|---|
| **Inventory Admin** | new `inventory_admin`, rank 65, scopes company + department | view, item.manage, stock.add, stock.issue, stock.adjust |
| **Store Manager** | new `store_manager`, rank 45, scopes company + department | view, stock.add, stock.issue |
| **Researcher** | existing `research_scientist`, `lab_technician`, `data_analyst`, `project_lead` | view, request |
| **Management Viewer** | existing `management_viewer` | view |
| — | existing `super_admin`, `company_admin` | all (via `ALL_PERMISSIONS`) |
| — | existing `rd_head`, `department_head` | view (via the `MANAGEMENT` bundle) |

Implementation detail: `inventory.view` (and `inventory.request`) are added to the shared
`VIEW`/`CONTRIBUTOR` bundles in `roles.ts`, so every existing role inherits read access in one
line. Only the two new roles carry the mutating permissions. Nobody's existing access to
files, folders or reviews changes.

`npm run seed` already iterates `DEFAULT_ROLES` and creates-or-updates each system role, so
it picks the two new roles and the amended permission lists up with **no change to
`scripts/seed.ts`**. It must be re-run after deploy.

### 3.3 Enforcement

Reads and writes are gated differently, and deliberately.

**Reads are organization-wide.** Stock levels are operational data, not research content:
an item has no owner, no ACL and no confidentiality classification. This follows the existing
precedent of `departmentVisibilityFilter` and `userDirectoryFilter`, which already scope the
department list and the employee directory to `{ organizationId }` alone. Any actor holding
`inventory.view` sees the whole catalogue. A new `inventoryVisibilityFilter(actor)` in
`src/server/permissions/visibility.ts` states this explicitly so list endpoints keep their
"permission is part of the query, never a post-filter" property and paginated totals stay
honest.

**Writes are scoped.** A new `src/server/services/inventory-access.ts` provides
`assertInventoryPermission(actor, permission, item?)`, mirroring the existing
`assertCompanyPermission`:

- inactive actor → `ForbiddenError`;
- super admin → allowed;
- a **company**-scoped grant carrying the permission → allowed;
- a **department**-scoped grant carrying the permission whose `scopeId` equals the item's
  `departmentId` → allowed;
- otherwise `ForbiddenError`.

Central-store items (`departmentId: null`) therefore require a company-scoped grant to
mutate — which is the correct reading of "central".

**Why not run this through `canAccess`.** `canAccess` resolves ACLs, folder inheritance,
ownership and the confidentiality gate. Inventory has none of those. Pushing it through would
mean inventing a resource type, adding a branch to `roleScopeGrants`, and giving the module a
confidentiality field it does not want — changes to the single most security-critical file in
the repository, for no benefit. `assertCompanyPermission` exists precisely because
"administrative check that is not about an ACL-bearing resource" is already a recognised case
here; this is the department-scoped sibling of it. `src/server/permissions/authorize.ts` and
`actor.ts` are **not modified**.

Every route calls the assertion server-side. The permission list in the session DTO is a
rendering hint only, exactly as it is everywhere else in this codebase.

---

## 4. Correctness invariants

These are the properties that must hold no matter what the client sends, and how each is
enforced.

| Invariant | Enforcement |
|---|---|
| Stock can never go negative | The issue/adjust decrement is a single conditional `findOneAndUpdate` with `{ _id, 'batches.batchNumber': b, 'batches.quantity': { $gte: qty } }` in the **filter**. A concurrent issue that would overdraw matches nothing, returns `null`, and becomes a `ValidationError`. No read-then-write race exists. |
| Expired stock cannot be issued | The same filter carries `$or: [ { 'batches.$.expiryDate': null }, { 'batches.$.expiryDate': { $gt: now } } ]`; the service also rejects it up front with a clear message so the user gets an explanation rather than "not enough stock". |
| Inactive/discontinued items cannot be issued | `status: 'active'` is part of the same filter. |
| Every stock change writes history | Item update and `stockTransactions.append()` run inside `withTransaction`. Either both commit or neither does — so a changed quantity with no history row is not a state the database can reach. |
| Derived fields agree with batches | Recomputed in the same update; a Phase 4 test asserts equality after a randomised sequence of operations. |
| History cannot be edited or deleted | Model-level `pre` hooks + repository surface + no route (§2.2). |
| Unauthorized users cannot change stock | `assertInventoryPermission` on every mutating route; Phase 4 tests assert 403 for researcher / management-viewer / no-role actors on all five mutation endpoints. |
| Issue targets are real and reachable | `projectId` / `experimentId` are resolved through the existing `projectService.getById` / `experimentService` so an actor cannot charge stock to a project they cannot see; `issuedToUserId` is resolved through the user directory. |

The audit trail is written in addition to the transaction row: `stockTransactions` is the
domain ledger, `auditLogs` is the governance record, and they answer different questions.

New audit actions to add to `AUDIT_ACTIONS`: `inventory.item_created`,
`inventory.item_updated`, `inventory.item_deactivated`, `inventory.stock_added`,
`inventory.stock_issued`, `inventory.stock_returned`, `inventory.stock_adjusted`,
`inventory.stock_expired`.

---

## 5. Alerts

Alerts are **derived at query time**, not stored — a stored alert is a second copy of the
truth that goes stale the moment a clock ticks past an expiry date.

| Alert | Condition |
|---|---|
| Out of stock | `availableQuantity === 0` (indexed via `stockState`) |
| Low stock | `0 < availableQuantity ≤ minimumStock` (indexed via `stockState`) |
| Near expiry | `now ≤ expiryDate ≤ now + NEAR_EXPIRY_DAYS` (indexed) |
| Expired | `expiryDate < now` with batch quantity remaining (indexed) |

`NEAR_EXPIRY_DAYS = 30` lives as a constant in a new `src/server/domain/inventory.ts`
alongside the category and unit vocabularies. (The existing `appSettings` collection is the
natural home if it later needs to be administrator-configurable; it is not worth a settings
screen now.)

Writing off expired stock is a *state change* and therefore not derived: a Phase 3
`scripts/inventory-expiry-sweep.ts` zeroes fully-expired batches and appends `expired`
transactions attributed via `auditService.recordSystem` — the same mechanism the existing
drive-sync and integrity jobs use for unattended work. Adding it to
`docker/scheduler/crontab` is a one-line, optional operations change.

---

## 6. API plan

All under `/api/inventory/`, all wrapped in `withAuthenticatedRoute`, all
`runtime = 'nodejs'`, `dynamic = 'force-dynamic'` — matching every existing route.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/inventory/items` | `inventory.view` | search + filters + pagination |
| POST | `/api/inventory/items` | `inventory.item.manage` | |
| GET | `/api/inventory/items/[itemId]` | `inventory.view` | includes batches |
| PATCH | `/api/inventory/items/[itemId]` | `inventory.item.manage` | never changes quantity |
| DELETE | `/api/inventory/items/[itemId]` | `inventory.item.manage` | soft delete; refuses while stock remains |
| GET | `/api/inventory/items/[itemId]/history` | `inventory.view` | |
| POST | `/api/inventory/stock/receipts` | `inventory.stock.add` | add stock |
| POST | `/api/inventory/stock/issues` | `inventory.stock.issue` | issue stock |
| POST | `/api/inventory/stock/adjustments` | `inventory.stock.adjust` | return / correct / write off |
| GET | `/api/inventory/transactions` | `inventory.view` | full history, filterable |
| GET | `/api/inventory/alerts` | `inventory.view` | four buckets + counts |
| GET | `/api/inventory/dashboard` | `inventory.view` | counts + recent added/issued |

Quantity is **never** a writable field on the item routes. The only way a number moves is
through a receipt, an issue or an adjustment — each of which writes history. That is a
structural guarantee, not a convention.

There is no `PATCH` or `DELETE` on transactions, by design.

---

## 7. UI plan

New route segment inside the existing authenticated `(drive)` shell — the sidebar, header,
theme, providers and session handling are inherited unchanged.

```
src/app/(drive)/inventory/layout.tsx              guard + tab nav (mirrors admin/layout.tsx)
src/app/(drive)/inventory/page.tsx                dashboard
src/app/(drive)/inventory/items/page.tsx          item list, search, filters
src/app/(drive)/inventory/items/[itemId]/page.tsx item detail: batches, history, actions
src/app/(drive)/inventory/history/page.tsx        full stock history
src/app/(drive)/inventory/alerts/page.tsx         alerts
```

```
src/components/inventory/inventory-dashboard.tsx
src/components/inventory/item-list.tsx            table + search + filter chips
src/components/inventory/item-dialog.tsx          add / edit item
src/components/inventory/item-detail.tsx
src/components/inventory/receive-stock-dialog.tsx
src/components/inventory/issue-stock-dialog.tsx   target picker: employee | department | project | experiment
src/components/inventory/adjust-stock-dialog.tsx
src/components/inventory/stock-history.tsx        shared by item detail and history page
src/components/inventory/inventory-alerts.tsx
src/components/inventory/stock-badges.tsx         stock state / expiry state badges
src/hooks/use-inventory.ts                        TanStack Query hooks + DTO types
```

Reused without modification: `Card`, `Table`, `Dialog`, `Select`, `Input`, `Label`, `Badge`,
`Button`, `Skeleton`, `AlertDialog`, `Tooltip`, `Separator`; `sonner` toasts;
`react-hook-form` + `@hookform/resolvers`; `formatRelativeTime` from `src/lib/utils`;
`useSession`/`hasPermission` for hiding actions the user cannot perform (the server still
decides); the existing employee directory (`/api/users`), department and project endpoints
for the issue-target pickers.

The layout guard mirrors `admin/layout.tsx`: `requireActor('/inventory')`, then a check that
the actor holds `inventory.view` in any grant, else `redirect('/access-denied?reason=permission')`.

Search covers item name, code, category, batch number, supplier and storage location (the
text index in §2.1 plus explicit category/location filters). Filter chips: Available, Low
stock, Out of stock, Near expiry, Expired — each mapping to an indexed condition from §5.

---

## 8. Files that need changing

### Existing files — modified (all additive)

| File | Change |
|---|---|
| `src/server/domain/permissions.ts` | append six `inventory.*` permissions |
| `src/server/domain/roles.ts` | add `inventory.view`/`inventory.request` to the shared bundles; add `inventory_admin` and `store_manager` definitions |
| `src/server/db/models/index.ts` | export + register the two new models |
| `src/server/db/models/audit-log.model.ts` | append eight `inventory.*` audit actions |
| `src/server/permissions/visibility.ts` | add `inventoryVisibilityFilter` |
| `src/server/http/dto.ts` | add `toInventoryItemDto`, `toStockTransactionDto`, `toInventoryAlertsDto`, `toInventoryDashboardDto` |
| `src/components/layout/nav-config.ts` | add an "Inventory" section |
| `src/components/layout/sidebar.tsx` | gate the new section on `inventory.view` (generalises the existing hardcoded admin gate) |
| `tests/helpers/fixtures.ts` | add `inventoryAdmin` and `storeManager` fixture users + grants (test-only) |
| `README.md`, `CHANGELOG.md` | document the module |

### Existing files — explicitly NOT touched

`src/server/permissions/authorize.ts`, `src/server/permissions/actor.ts`,
`src/server/storage/**`, `src/server/services/upload.service.ts`, `download.service.ts`,
`drive.service.ts`, `drive-sync.service.ts`, `storage-migration*`, `file.service.ts`,
`folder.service.ts`, `scripts/seed.ts`, every existing route handler, `next.config.ts`,
`eslint.config.mjs`, `package.json`.

No new dependencies.

### New files

```
src/server/domain/inventory.ts                       categories, units, thresholds, state helpers
src/server/db/models/inventory-item.model.ts
src/server/db/models/stock-transaction.model.ts
src/server/repositories/inventory-item.repository.ts
src/server/repositories/stock-transaction.repository.ts
src/server/services/inventory-access.ts
src/server/services/inventory.service.ts             items, alerts, dashboard
src/server/services/stock.service.ts                 receipts, issues, adjustments
src/server/validation/inventory.schemas.ts
src/app/api/inventory/**                             12 route handlers
src/app/(drive)/inventory/**                         6 pages + layout
src/components/inventory/**                          10 components
src/hooks/use-inventory.ts
scripts/inventory-expiry-sweep.ts                    (Phase 3)
tests/security/inventory-permissions.test.ts
tests/integration/inventory-stock.test.ts
tests/unit/inventory-domain.test.ts
docs/inventory/00-analysis.md                        (this file)
```

The new server files respect all three ESLint architectural boundaries: no `next`/`react`
import under `src/server/**`, no `fs` anywhere, no `@/server/db|repositories|services|storage`
import from `src/components/**` or `src/hooks/**`.

---

## 9. Open decision (flagged, not blocking)

§8 of the brief gives Researchers "view stock and **request items**", but features 1–9 define
no request workflow, no request collection and no approval path for one. Building a
request/approval system would be a materially larger module than the one specified.

**Assumption taken:** `inventory.request` is declared in the permission vocabulary now so the
role matrix is honest, but no request workflow is built in Phases 1–4. Researchers get
read access plus the existing notification/comment channels.

If a request queue *is* wanted, it needs a third collection (`stockRequests`) and an
approve → issue flow, and belongs in a Phase 5. Confirm before Phase 2 starts.

---

## 10. Phase plan and exit criteria

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **0** | This analysis | approved |
| **1** | Domain, models, item repository/service, item + search/filter routes, nav, item list/add/edit/detail UI | `typecheck`, `lint`, item CRUD works, no quantity field is writable |
| **2** | `stock.service`, receipt/issue/adjust routes and dialogs, quantity + expiry validation, project/experiment linking | negative stock impossible under concurrency; expired batches refused; every mutation writes a transaction row |
| **3** | History views, alerts, dashboard, expiry sweep script | history read-only in UI and API; four alert buckets correct; dashboard counts match the collections |
| **4** | Full verification | `npm run typecheck`, `npm run lint`, `npm test` (existing 369 tests still green), `npm run build`; the six required behaviours in §4 each covered by a test; Drive suites (`tests/integration/upload-to-drive`, `drive-sync`, `dual-storage-reads`, `storage-migration`, `tests/security/drive-storage-credentials`) unchanged and passing |

At the end of every phase: files changed, what changed and why, tests run, errors reported —
and a stop if anything critical is outstanding.
