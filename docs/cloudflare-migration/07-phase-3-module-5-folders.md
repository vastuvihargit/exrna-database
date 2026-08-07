# Cloudflare Migration — Phase 3, Module 5: The Folder Repository

**Status:** complete. MongoDB remains the live database. No UI file changed.
**Predecessors:** [`06-…module-4-acl-design.md`](./06-phase-3-module-4-acl-design.md)
**Scope:** folders only. Files, file versions, reviews, inventory and notifications are untouched.

---

## 1. What this module produced

```
src/server/repositories/
  folder.repository.contract.ts     the database-neutral surface
  folder.repository.mongo.ts        the existing queries, behind that surface
  folder.repository.d1.ts           new
  folder.repository.ts              façade, routed by DATA_SOURCE_FOLDERS

src/server/permissions/
  visibility.d1.ts                  + lookupVisibility()
  visibility.ts                     + resourceLookupFilter()

tests/d1/folder-repository.test.ts  53 tests against a real D1
tests/security/folder-management.test.ts  + 4 MongoDB parity tests
```

`DATA_SOURCE_FOLDERS` is unset. Nothing changed for the running system.

---

## 1a. Method mapping

Every public method on the MongoDB repository, and what it became. The names are identical on
both sides — the contract was extracted from the MongoDB implementation rather than invented —
so the column that carries information is not "D1 method" but the three after it.

"Visibility" is the predicate applied **inside** the query: `lookup` is `lookupVisibility()`
(single-row, a superset of `canAccess`), `child` is `childVisibility()`, `resource` is
`resourceVisibility()`. "—" means the method takes no actor, and the next column says why that
is safe.

| MongoDB method | D1 method | Tables | Visibility | Atomic | Tests |
|---|---|---|---|---|---|
| `findById` | same | `folders`, `folder_ancestors`, `resource_permissions` | `lookup` | — | 1–18, 20, 21 |
| `findByIds` | same | as above | `lookup` | — | 25, 26 |
| `listChildrenOf` | same | as above | `child` | — | 22, 23, 23b, archived |
| `countChildrenOf` | same | `folders`, `resource_permissions` | `child` | — | 22, 23 |
| `listTrashed` | same | as above | `child` | — | 19, 27 |
| `listArchived` | same | as above | `child` | — | archived listing |
| `search` | same | as above + `folder_ancestors` | `resource` | — | 24, 24b, 24c |
| `listSharedWith` | same | as above | principals + live-grant `EXISTS` | — | 28 |
| `existsWithName` | same | `folders` | — structural; name collision within one parent, no row returned | — | duplicate names |
| `findChildByName` | same | `folders` | — caller has authorised the parent | — | duplicate names |
| `takenChildNames` | same | `folders` | — returns names only, inside an authorised parent | — | taken names |
| `countDescendants` | same | `folders`, `folder_ancestors` | — subtree mutation authorised at its root | — | descendants |
| `findByIdInternal` | same | `folders`, `folder_ancestors` | **bypass** — §4 | — | 20, 21, Drive mirror |
| `findByIdsInternal` | same | as above | **bypass** — the ancestor chain must be complete | — | boundary tests |
| `findByDriveFolderIdInternal` | same | as above | **bypass** — Drive change feed | — | mirrored-folder test |
| `findByRootKeyInternal` | same | as above | **bypass** — drive already authorised | — | roots |
| `findByRootKeysInternal` | same | as above | **bypass** — as above | — | roots |
| `listDescendantsInternal` | same | `folders`, `folder_ancestors` | **bypass** — subtree mutations | — | descendants |
| `findExpiredTrashInternal` | same | `folders` | **bypass** — purge runs as no user | — | retention cursor |
| `create` | same | `folders`, `folder_ancestors` | service authorises; repo enforces parent + tenancy | `batch` | ancestor chain, bad parent |
| `ensureRoot` | same | `folders` | — system roots | unique index | roots created once |
| `updateById` | same | `folders`, `resource_permissions` | service authorises | `batch` | rename, ACL replace |
| `adjustChildFolderCount` | same | `folders` | service authorises | single stmt | counter |
| `moveSubtree` | same | `folders`, `folder_ancestors` | service authorises both ends; repo restates the structural refusals | `batch` + guard | all move tests |
| `setSubtreeDeleted` | same | `folders`, `folder_ancestors` | service authorises | `batch` | trash/restore |
| `setSubtreeStatus` | same | `folders`, `folder_ancestors` | service authorises | `batch` | archive |
| `purge` | same | `folders`, `folder_ancestors` | **bypass** — retention job | `batch` | purge |
| `checkHierarchyIntegrity` | same | `folders`, `folder_ancestors` | admin/test tooling | — | 6 checker tests |

`toRecord` and `isValidId` are MongoDB-local helpers (BSON hydration and `ObjectId` validation).
Neither has a D1 counterpart and neither is part of the contract.

---

## 2. Three signatures could not survive the move, and why

### 2.1 Reads take an `Actor`, not a filter fragment

`listChildrenOf({ visibility })` took a MongoDB filter object the service had built. A
`Record<string, unknown>` means nothing to SQL, so the contract takes the **actor** and each
implementation builds its own predicate — `childVisibilityFilter()` on one side,
`childVisibility()` on the other.

The property that mattered is preserved and slightly strengthened: a listing cannot be written
without a visibility predicate, because the predicate is now derived *inside* the repository
from a required argument, rather than passed in by a caller who could forget it.

### 2.2 `updateById` takes a patch, not an update document

`{ $set: … }` and `{ $inc: … }` are MongoDB operators. `FolderPatch` names the eight fields the
application actually writes. `fileCountDelta` is the only counter that was ever `$inc`-ed.

`name` writes `nameLower` too, in both implementations. The two must never disagree, and leaving
that to eleven call sites is how they eventually do.

### 2.3 Mutations still take a transaction handle — and D1 still cannot honour it

`folder.service.ts` opens a `withTransaction` around a folder mutation *and the matching file
mutation*. That is real atomicity and it is still needed while `files` is on MongoDB, so the
handle stays on the contract (`FolderTx`) and the Mongo implementation uses it exactly as before.

D1 does not honour it, and does not pretend to. Every D1 mutation here is internally atomic
through `db.batch()` — the guarantee the session was providing for *these* statements.

**Update (module 7).** Atomicity *across* folders and files is now provided on D1 as well, by
`src/server/db/d1-unit-of-work.ts`: a folder move composes both repositories' statement builders
into a single batch. `moveSubtree` below is still the folders-only path and is unchanged; what
the service calls for a real move is the composed one. See
`09-phase-3-module-7-atomic-moves.md`.

The mixed window it describes has not been made safe — it has been **closed by refusal**. With
`DATA_SOURCE_FOLDERS` and `DATA_SOURCE_FILES` set to different values, a folder move returns 409
rather than writing `folders` in one database and `files` in another. Reads are unaffected.

---

## 3. `findById` is now permission-aware — and had to get *wider* to be safe

The brief requires the user-facing lookup to enforce permission in SQL. Doing that naively —
reusing `resourceVisibility` — would have been a regression, because a listing predicate is
allowed to be narrower than `canAccess` and a lookup predicate is not: a repository returning
`null` becomes a 404 on a folder the actor may legitimately open.

Three cases `resourceVisibility` omits, all allowed by `canAccess`:

| Case | `canAccess` step |
|---|---|
| a department- or project-**scoped role grant** on somebody else's department | 9, `roleScopeGrants` |
| a **folder-scoped** role grant, covering the folder and everything under it | 9, `roleScopeGrants` |
| a company-wide reader's **own** content classified above their clearance | 8, ownership |

So `lookupVisibility()` (D1) and `resourceLookupFilter()` (MongoDB) were added: a deliberate
**superset of `canAccess`'s allow set**. What they do *not* relax is the part that matters —
organization isolation and the live deny guards are AND-ed over everything, super admins
included. `assertCan` still makes the real decision afterwards, with the full ancestor chain.
This is the half that runs inside the query, so a guessed id never loads a row.

**Search deliberately keeps the narrower `resourceVisibility`.** File search already applies
exactly that predicate, and the two halves of one search response showing different amounts of
the drive would be worse than either.

---

## 4. Internal lookups: three, each named and each justified

`findById` cannot be permission-aware everywhere, and the places it must not be are not
exceptions to the rule — they are a different question being asked.

| Method | Why it bypasses |
|---|---|
| `findByIdsInternal` | The **ancestor chain a permission decision walks**. `canAccess` looks along it for an inherited deny; filtering the chain by what the actor may see would drop exactly the ancestor carrying a denial they are not meant to know about, and the walk would then allow what it should refuse. A chain read with permission is not a permission check. |
| `findByDriveFolderIdInternal` | The Drive change feed starts from a Drive id and runs as the sync worker. Trashed folders included on purpose: a change arriving for a folder trashed here must still be recognised as *ours*, or the mirror's disagreement is filed as an unmanaged item and never reported. |
| `findByIdInternal`, `findByRootKey(s)Internal`, `listDescendantsInternal`, `findExpiredTrashInternal` | Post-mutation re-reads (permission already asserted on the row this request just wrote), subtree mutations authorized at the root of the subtree, drive-root key resolution the caller has already authorized, and the retention purge, which runs as no user at all. |

Every one is `⚠️`-marked on the façade, every call site carries a comment saying which of these
it is, and no API route calls one: routes go through `folder-access.ts`, which calls the
permission-aware `findById` for the folder and the internal one for the chain.

---

## 5. The hierarchy: a closure table, and the ordering trick that makes a move atomic

`pathAncestors[]` became `folder_ancestors(folder_id, ancestor_id, depth)`. Every hierarchy
mutation now writes two tables that must agree.

### The problem

`moveSubtree` needs values only a prior read can supply — the moved folder's current depth, and
therefore the shift every descendant's ancestor rows need. D1 fixes a batch before the first
statement runs, so those values are inevitably read *outside* the transaction that uses them.
A concurrent move or rename in between makes them wrong, and applying half a shift to a closure
table does not fail loudly: it produces a tree that is quietly in the wrong shape.

### The shape that solves it

Every statement carries the same guard — *"`folders.updated_at` for the moved folder is still
the value the plan was computed from"* — and **the moved folder's own row is updated last**, so
that guard holds for every earlier statement and is invalidated by the final one.

Either the state is untouched and all seven statements apply to exactly what was read, or
something moved first and every statement matches nothing. There is no partial outcome to clean
up. A no-op is detected by re-reading, and the whole operation is retried against the new state
— which is what makes two concurrent moves, or a rename racing a move, resolve into one winner
and one retry instead of a corrupted subtree.

Descendants are identified throughout by `folder_ancestors.ancestor_id = <moved folder>`, a
marker row that survives every step (its `depth` shifts; the row is never deleted), so the set
stays stable as the table is rewritten underneath it.

### Structural refusals restated at this layer

`folder.service.ts` already refuses a move into the folder itself, into a descendant, or across
organizations — and it should, because it can produce a better message. The repository refuses
them again, because a circular move corrupts the closure table in a way no later read reports as
an error, and this is the last layer that can still say no. `create` likewise validates that the
parent exists and is in the same tenant.

### `db.run(sql…)` cannot go in a drizzle batch

Worth recording, because it cost an afternoon: `drizzle-orm@0.45`'s D1 `batch()` calls
`preparedQuery.stmt.bind(...)`, and a raw `db.run(sql…)` has no `stmt` once it carries
parameters. Every statement in a batch must come from a query builder — including the two
`INSERT … SELECT`s, which use `db.insert(t).select(sql…)`.

---

## 6. Behaviour that is deliberately *not* identical

| | MongoDB | D1 | Why |
|---|---|---|---|
| purge a folder that still has a child | deletes the parent, leaves a dangling `parentFolderId` | foreign key refuses | The refusal is better than silent corruption. The MongoDB outcome is what `checkHierarchyIntegrity` now finds. |
| purge and `trashed_with_folder_id` | left pointing at a deleted row | cleared on survivors | The tag means "restoring *that* folder brings me back", and that folder is gone. |
| soft-delete filtering | Mongoose pre-hook, invisible in the query | `deleted_at IS NULL` written out per query | Phase 2 decision; an invisible filter a reader cannot see is worse than a repeated one. |

Everything else — sort order and `id` tie-breaker, roots excluded from search, archived
descendants keeping `archived_at` null, the trash listing showing only what the user deleted
themselves, `setSubtreeDeleted` returning `swept + 1` — is matched statement for statement.

---

## 7. The integrity checker

`checkHierarchyIntegrity(organizationId)` compares the parent pointer against the closure table
and reports: missing ancestor rows, wrong depths, cycles, ancestors from another organization,
and a parent that disagrees with the deepest ancestor row. Implemented for both engines
(MongoDB checks the array instead of the table).

It is admin/test tooling, not a request path. Every hierarchy test in the suite finishes by
running it, including the concurrency cases — where the interesting question is not "did the
move succeed" but "is the tree still coherent if it did not".

---

## 8. Verification

| | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | baseline (one pre-existing warning in `research-organization.test.ts`) |
| `npm run test:mongo` | 704 passed, 48 files |
| `npm run test:d1` | 290 passed, 7 files |
| `npm run cf:build` | passes |
| `npm run cf:preview` | boots |

`tests/d1/folder-repository.test.ts` covers the 28 isolation cases and the 18 hierarchy cases
the brief lists, plus routing. The four cases that can be expressed against the MongoDB fixture
are also asserted there, so the two engines are shown to agree rather than assumed to.

---

## 9. Schema changes

**None.** No migration added.

---

## 10. Rollback

```bash
# The flag, per environment, no deploy:
wrangler secret delete DATA_SOURCE_FOLDERS --env <environment>
```

MongoDB is the default: an unset variable, a typo and a misspelled module name all resolve to
it. There is **no fallback** — if a D1 call fails while the flag is on, the error propagates
rather than being retried against MongoDB, because a silent fallback would mean two databases
disagreeing about a folder tree with nobody watching.

```bash
# The module:
git revert <the four commits>
npm run typecheck && npm test
```

Note that the service layer and the repository signatures are coupled: reverting
`folder.repository.ts` without `folder.service.ts` fails to build, and the build failing is the
correct signal.

---

## 11. Carried forward

| Item | Phase |
|---|---|
| Cross-store atomicity for folder+file **moves** | done — 3, module 7 (`d1-unit-of-work.ts`) |
| Cross-store atomicity for folder+file **trash / restore / archive** | still two batches on D1 — see module 7 doc §11 |
| `folder-mirror.ts`, `drive-mirror.ts` and `storage-migration/planner.ts` read `FolderModel` directly and are MongoDB-only | Drive storage phase |
| `(file_id, depth)` index on `file_folder_ancestors` if file listings become hot | measure first |
| `checkHierarchyIntegrity` behind an admin endpoint or a scheduled job | 6 |

---

## 12. Acceptance criteria

- [x] Every folder method used by the application has a D1 equivalent
- [x] Visibility is applied inside SQL — to rows, `COUNT(*)`, and pagination totals, from one
      builder so the two cannot drift
- [x] Internal bypasses are explicitly named, justified, and unreachable from an API route
- [x] Hierarchy mutations are atomic and leave no partial state
- [x] MongoDB remains the default; rollback is an environment variable
- [x] No raw SQL in a UI component or an API route
- [x] `API route → service → authorization → repository → D1` preserved
- [x] No API response shape changed

---

## 13. Next

**Module 6 — files and file versions.** It closes the cross-store atomicity gap in §2.3, and it
is where `file_folder_ancestors`, `file_metadata` and the Google Drive version ids move.
