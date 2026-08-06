# Phase 3, Module 4 — Folder and File Access Control: design

**Status:** design only. No repository code written yet. This document is the specification
the D1 implementation is written against, produced before any SQL, because the brief's
mandatory proofs (*restricted users cannot access files by guessing IDs*, *search does not
reveal restricted files*) are properties of this design rather than of the queries.

---

## 1. Two different questions, answered by two different mechanisms

The codebase separates these, and the separation must survive the migration.

| | Question | Where | Wrong answer costs |
|---|---|---|---|
| **Visibility** | *Which rows may appear in a listing at all?* | `visibility.ts` → a filter fragment `$and`-ed into the query | A row appears that should not — including in `total` |
| **Capability** | *May this actor perform permission P on this resource?* | `authorize.ts:canAccess()` — 10 ordered steps | An action succeeds that should not |

Visibility is applied **inside the database query**. That is not a performance choice: a
`total` computed over rows the user cannot see is itself a disclosure, and so is a page that
comes back short. Post-filtering leaks through counts, pagination and facet numbers even when
the rows themselves are removed.

**Consequence for D1:** every listing predicate below must be expressible in SQL. Nothing may
be evaluated in the Worker after the fetch.

---

## 2. The eight permission sources

| # | Source | Stored as (Mongo) | Stored as (D1) |
|---|---|---|---|
| 1 | Ownership | `folders.ownerId` / `files.ownerId` | same columns |
| 2 | Explicit grant on the resource | `permissions[]` embedded array | `resource_permissions` rows |
| 3 | Explicit **denial** on the resource | `permissions[].deny = true` | `resource_permissions.deny = 1` |
| 4 | Inherited grant from an ancestor folder | ancestor's `permissions[]` + `inheritPermissions` | ancestor rows + `folders.inherit_permissions` |
| 5 | Company role grant | `user_roles` scope `company` | same |
| 6 | Department role grant | `user_roles` scope `department` | same |
| 7 | Project role grant / membership | `user_roles` scope `project`, `project_members` | same |
| 8 | Confidentiality clearance | `roles.maxConfidentiality` → `CLEARANCE_BY_MAX_LEVEL` | same |

**Principal identity.** An ACL entry names a *principal*, which may be a user, a department, a
project or a **role**. The actor's principal set is therefore:

```
principalIds = [ actor.userId, actor.departmentId?, ...actor.projectIds, ...actor.grants.map(roleId) ]
```

This is `actorPrincipalIds()` today and must be reproduced exactly. Missing the role ids would
silently revoke every role-targeted share in the system.

---

## 3. Precedence — capability (`canAccess`)

Ordered. The first rule that fires decides; later rules never rescue an earlier refusal.

1. **Actor not `active`** → refuse. (This is the immediate-deactivation guarantee.)
2. **Cross-tenant** → refuse. *Super admin included.*
3. **Deleted or trashed resource** → refuse, except `resource.restore` and `file.view`.
4. **Explicit deny**, on the resource *or anywhere in the inherited chain* → refuse. Beats
   everything below, super admin included.
5. **Super admin** → allow.
6. **Direct ACL allow** → allow.
7. **Inherited ACL allow** → allow.
8. **Ownership** → allow for `OWNER_PERMISSIONS`. Not subject to the clearance gate — the
   owner classified the file. `access.manage` is granted to the owner **only** when the
   resource has neither department nor project (i.e. a personal drive), so that a junior
   researcher cannot break inheritance to hide work from an accountable department head.
9. **Role grant at a containing scope** → allow *only if* the clearance gate passes.
10. Otherwise refuse.

**Inheritance walk:** leaf → root, stopping at the first ancestor with
`inheritPermissions = false`. A deny found anywhere during the walk refuses immediately. If the
resource itself has `inheritPermissions = false`, no ancestor is consulted at all.

**Clearance gate** applies to source 5/6/7 only — never to ownership (8) or to a direct/
inherited grant (6/7). Someone explicitly given a file was given it deliberately.

---

## 4. Precedence — visibility, and the two filters

### 4.1 `resourceVisibilityFilter` — "can this actor reach this resource from nothing"

Used for search and for cross-tree lookups (`file.service.ts:708`). Branches, OR-ed:

- owner, at **any** classification
- any ACL entry naming one of the actor's principals
- the actor's department, **within clearance**
- the actor's projects, **within clearance**

Company-wide readers and super admins short-circuit to `confidentiality IN (clearance)`.

> **Never degenerates to match-all.** With no department, no projects and no shares, the
> filter is `_id IN []` — an explicit impossible predicate. The D1 form must be equally
> explicit (`1 = 0`), not an omitted `WHERE`.

### 4.2 `childVisibilityFilter` — "listing children of a folder already authorized"

The parent has been authorized, so inheritance is the normal case and the query expresses only
the *exceptions*:

- a **deny guard** — no ACL entry naming the actor with `deny = true`; applied to super admins
  and company-wide readers too
- a child that broke inheritance and grants the actor nothing directly
- a child classified above clearance, unless owned or directly granted

### 4.3 A behaviour to preserve, not repair

`resourceVisibilityFilter`'s ACL branch matches `permissions.principalId` **without checking
`deny` or `expiresAt`**. So a resource carrying an explicit *denial* naming the actor is still
**visible** through that filter, and an expired share still grants visibility.

`childVisibilityFilter` *does* carry a deny guard; `listSharedWith` *does* check expiry.

This asymmetry is in production today. Capability is unaffected — `canAccess` step 4 refuses
the action — so the exposure is limited to a row appearing in a search listing. **It is
reproduced exactly in D1, with a test pinning it,** because changing it here would make the
Phase 6 MongoDB↔D1 comparison disagree for reasons unrelated to the migration.

It is recorded as a product question for after cutover, not a migration decision. Flagged in
§9.

---

## 5. The SQL shapes

`resource_permissions` is one table for both resource types (`resource_type`, `resource_id`),
so folders and files share every predicate below.

**Deny guard** — the security-critical one. `NOT EXISTS`, never `LEFT JOIN … IS NULL`:

```sql
NOT EXISTS (
  SELECT 1 FROM resource_permissions rp
   WHERE rp.resource_type = :type AND rp.resource_id = f.id
     AND rp.principal_id IN (:principals) AND rp.deny = 1
)
```

**Direct grant:**

```sql
EXISTS (
  SELECT 1 FROM resource_permissions rp
   WHERE rp.resource_type = :type AND rp.resource_id = f.id
     AND rp.principal_id IN (:principals)
)
```

**Subtree containment** — `pathAncestors: oid(x)` becomes `folder_ancestors` /
`file_folder_ancestors`, which is why Phase 2 made them tables:

```sql
EXISTS (SELECT 1 FROM folder_ancestors fa WHERE fa.folder_id = f.id AND fa.ancestor_id = :under)
```

**Clearance** is a bounded `IN` list built from `CLEARANCE_BY_MAX_LEVEL`.

**Principal list** is bound as parameters, never interpolated. It is unbounded in principle
(one entry per role grant); it will be capped with an explicit, logged limit rather than
silently truncated.

### 5.1 Ancestor ACLs in one query

`canAccess` takes `ancestorAcls` ordered root → parent. D1 loads them in a single query joining
`folder_ancestors` to `resource_permissions`, ordered by depth — the shape Phase 0 anticipated.
This is the one place a fetch-then-evaluate is correct: it is a *capability* decision on a
single known resource, not a listing predicate.

---

## 6. Ordering, pagination and shape to preserve

- **Folders before files** in mixed listings — currently two queries merged by the service.
- Sort keys `name | updatedAt | createdAt`, with **`id` as a tie-break** so pagination is
  stable when timestamps collide.
- `nameLower` is the sort/search column, not `name`.
- Folder search excludes roots (`parent_folder_id IS NOT NULL`) — matching "My Drive" adds
  nothing and would dominate every result set.
- Folder name search is an **anchored/substring match on `nameLower`**, not FTS: a researcher
  typing `prot` expects `Protocols`, which a stemmed word search would not return.
- File search uses `files_fts` and **must** use `toFtsQuery()` from module 3 — raw user input
  is an FTS5 syntax error, not a miss.
- `bm25()` weights must include the placeholder for the UNINDEXED column:
  `bm25(files_fts, 0.0, 10.0, 6.0, 5.0, 1.0)`. See module 3 §6.

---

## 7. Soft delete, per resource

Both `folder.model.ts` and `file.model.ts` **do** call `applySoftDeleteFilter` (unlike users,
departments, roles and projects). So every folder and file read excludes soft-deleted rows
unless `withDeleted: true` is passed — which Trash and the purge job do pass, and
`findByIds`/`findByDriveFolderId` pass permanently.

`findByDriveFolderId` including trashed rows is deliberate: a Drive change arriving for a
folder trashed on our side still has to be recognised as *ours*, or the mirror's disagreement
is never reported.

**Trashed rows follow the same access rules** — Trash listings carry the visibility filter, and
`canAccess` step 3 restricts them to `resource.restore` / `file.view`.

---

## 8. Adversarial tests this design must be proven against

Non-negotiable before the module is called complete:

1. Restricted **file** by guessed id → refused
2. Restricted **folder** by guessed id → refused
3. Folder listing excludes unauthorized children
4. File listing excludes unauthorized files
5. Search excludes unauthorized records
6. Recent excludes unauthorized records
7. Starred excludes unauthorized records
8. Trash excludes unauthorized records
9. **`total` and pagination do not reveal hidden records** — asserted on the count, not just
   the page
10. Explicit deny overrides inherited allow
11. Department A cannot see department B's files
12. Project A cannot see project B's files
13. Trashed/deleted records follow the same rules
14. Cross-tenant refused for a **super admin**
15. Deny beats super admin
16. `resource_permissions` naming a *role* the actor holds grants access (the principal set
    includes role ids)
17. An actor with no department, no projects and no shares sees only their own content — the
    filter does not degenerate to match-all

Each must be run against **both** engines where a Mongo equivalent exists, so a divergence is a
test failure rather than a Phase 6 surprise.

---

## 9. Carried forward

| Item | Where |
|---|---|
| `resourceVisibilityFilter` ignores `deny` and `expiresAt` (§4.3) — product question, post-cutover | after Phase 7 |
| Principal-list cap must be explicit and logged, never a silent truncation | module 4 implementation |
| `resourceVisibilityFilter` and `childVisibilityFilter` stay MongoDB-shaped until this module lands | module 4 implementation |

---

## 10. Next

Implementation: a `permissions/visibility.d1.ts` producing parameterised Drizzle predicates
from the same `Actor`, then `folder.repository.d1.ts` and `file.repository.d1.ts` consuming
them, then the §8 suite.
