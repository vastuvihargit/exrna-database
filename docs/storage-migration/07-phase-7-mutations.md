# Phase 7 — File and folder mutations

*Written after the fact. Phase 7 shipped without a design note; this one is derived from
`src/server/services/storage-migration/drive-mirror.ts` and the 17 tests in
`tests/integration/drive-mutations.test.ts`, and describes what is actually there rather than
what was planned.*

Rename, move, trash and restore now apply to the Shared Drive as well as to the database.
Without this, somebody browsing the Shared Drive sees a tree that stopped matching reality the
first time anyone renamed anything.

---

## 1. The ordering rule

**Drive first, then MongoDB, and undo Drive if MongoDB fails.**

The alternative — commit locally and mirror afterwards — produces a record saying a file was
renamed, moved or trashed while the Shared Drive still shows the old state, and nothing in the
system knows the two disagree. Every such divergence would be silent and permanent.

Drive-first means a Drive failure happens *before* anything local has changed: both sides are
still at the original state, and the user gets a plain "that did not work", which is the truth.
The message is deliberately non-technical — an employee cannot act on a Drive API error, and
the part that matters is the second sentence: *nothing was changed*.

The remaining window is small and handled: Drive succeeded, MongoDB then failed. A compensating
Drive call puts it back. If the compensation *also* fails, that is logged loudly and left for
Phase 9's reconciliation — but the local state is unchanged either way, so nothing an employee
sees is wrong.

---

## 2. What one operation touches

A **folder** operation is one Drive call, because Drive cascades: moving or trashing a mirrored
folder carries its contents.

A **file** operation touches one Drive object per migrated version, because each version is a
separate object. Two consequences follow:

- **A partial application is rolled back.** Renaming a three-version file where the second call
  fails would otherwise leave one object renamed and two not — a state no later operation would
  ever notice or correct. `applyToEach` undoes the ones that succeeded.
- **There is a ceiling.** `MAX_MIRRORED_OBJECTS_PER_ACTION = 50`. A file with more migrated
  versions than that is pathological, and the limit exists so a single click can never become a
  thousand sequential Drive calls inside one HTTP request.

---

## 3. Creating a folder is not mirrored

Deliberately. Decision D7 keeps folder mirroring **lazy**: a Drive folder appears the first time
content needs to land in it.

Making `POST /api/folders` wait on a remote call would turn a fast transactional write into a
distributed one, and would fill the Shared Drive's item budget with empty folders — a real
constraint, since a Shared Drive has a hard item limit that the migration planner already
projects against.

---

## 4. Deployments where none of this applies

`driveHierarchy()` returns `null` when Drive is not enabled, not registered, or unavailable, and
every caller treats null as "there is nothing to keep in step" rather than as an error. That is
what lets the mirror be threaded through the mutation services without a feature flag at each
site, and it is why a deployment part-way through migration — or one that never enables Drive —
runs the same code paths with the same behaviour as before.

A test asserts Drive is touched not at all in that configuration.

---

## 5. Acceptance criteria

| Criterion (brief, Phase 7) | Evidence |
|---|---|
| Google Drive and MongoDB remain consistent | Rename, move, trash and restore each asserted on both sides, including across multiple versions of one file |
| Failed operations do not appear successful | Drive failure → nothing local changed, plain error. MongoDB failure → the Drive change is compensated. Both injected and tested |
| Existing user experience remains unchanged | No client change in this phase |
| Audit logs are created | The existing `file.*` / `folder.*` actions, unchanged — the mirror is not a separate event |
