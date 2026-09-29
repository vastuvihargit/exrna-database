# Phase 3, module 10 — search and the lifecycle read paths on D1

**Status: complete.** Stars, recent items and saved searches have D1 implementations behind
contracts and route on `DATA_SOURCE_SEARCH`. Two defects were found and fixed on the way, one of
them a production-reachable failure in code that had already shipped. §7 records the
verification. Nothing here is enabled in production.

---

## 1. What this module is

The user-facing views that are not "a folder's contents": **Search**, **Recent**, **Starred**,
**Shared with me**, **Trash**, **Archive**, the search facets and the project content breakdown.

Most of the SQL for them already existed. `file.repository.d1.ts` and `folder.repository.d1.ts`
were written in modules 5 and 6 with `search`, `listTrashed`, `listArchived`, `listSharedWith`,
`searchFacets`, `findRelated` and `projectContentBreakdown` on the contract from the start,
because the contract was fixed before the implementations landed. What was missing was the
*other* half of those pages:

| Repository | Was | Now |
|---|---|---|
| `star.repository` | Mongo only, no contract | contract + Mongo + D1 + façade |
| `recent-item.repository` | Mongo only, no contract | contract + Mongo + D1 + façade |
| `saved-search.repository` | Mongo only, no contract | contract + Mongo + D1 + façade |

Starred and Recent are two-step reads: the repository returns *ids*, and the file and folder
services put those ids straight back through their own permission-aware `findByIds`. That is
the property that makes the flag independent — a star stored in D1 pointing at a file still on
Mongo resolves correctly — and it is also the security property: **a star is not a capability.**
Access revoked after something was starred removes it from the Starred page on the next read,
because the second step re-authorizes from scratch.

## 2. One flag for three repositories

`DATA_SOURCE_SEARCH` routes all three. They are one module because none of them can be moved
usefully on its own and three flags would be three ways to end up half-migrated. Nothing else
changes with them: which files a Starred page actually *shows* is decided by
`DATA_SOURCE_FILES` and `DATA_SOURCE_FOLDERS`.

## 3. Upsert semantics, which differ between the two by design

Easy to get backwards, and a swap produces a plausible-looking page that is quietly wrong.

| | Conflict behaviour | Why |
|---|---|---|
| `stars.add` | `ON CONFLICT DO NOTHING` | Re-starring must not reorder the Starred page. Matches Mongo's `$setOnInsert`. |
| `recentItems.touch` | `ON CONFLICT DO UPDATE` | Moving the item to the top *is* the point. `organization_id` is still left alone — a row's tenant is set once, and an access must not rewrite it. |

Both are single statements rather than read-then-write. `add()` is behind a toggle a user can
double-click and open in two tabs; a `SELECT` then `INSERT` would let both see "not starred",
and the unique index would turn the second into a 500 for an action that had already succeeded.

## 4. The Mongo aggregate soft-delete defect — fixed, not carried across

`applySoftDeleteFilter` hooks `find`, `findOne`, `findOneAndUpdate`, `countDocuments`,
`updateMany` and `updateOne`. Mongoose does **not** route `aggregate` through query middleware,
so every hand-written `$match` has to carry `deletedAt: null` itself — and in
`file.repository.mongo.ts` two of them did not.

The result was a dashboard inconsistent with itself:

* `searchFacets` — both aggregates counted trashed files. A user reading `qpcr (2)` beside a
  single result row is being told, accurately, that a second file exists. That is a disclosure
  as well as an inconsistency: a file may have been trashed *because* it should not have been
  there.
* `projectContentBreakdown` — four of the five figures are aggregates and counted trashed
  files, while `linkedToExperiment` is a `countDocuments` and did not. Two numbers on one
  screen, computed over different populations.

The D1 implementation excluded them from the start and recorded the divergence in §3 of
`file.repository.d1.ts`, deferring the Mongo fix rather than making it in a session whose remit
was the D1 implementation. This module makes it. The predicate is now a named constant,
`NOT_TRASHED`, so a future aggregate cannot omit it by simply not thinking about it.

Tests pin the corrected behaviour on **both** engines, which is the point — parity that is
asserted rather than assumed.

## 5. One FTS query builder, not two

`experiment.repository.d1.ts` and `file.repository.d1.ts` each had one, and they were not the
same function.

```
experiments   text.match(/[\p{L}\p{N}_]+/gu).slice(0, 32)   →  extraction, bounded
files         text.split(/\s+/).map(escape quotes)          →  escaping, unbounded
```

Escaping is safe against *injection* — a doubled quote inside a quoted phrase is FTS5's own
escape — but not against two other things:

* **Errors.** A token made only of punctuation (`***`, `--`, `!`) quotes to a phrase containing
  no tokens at all, and what FTS5 does with an empty phrase is a version-dependent detail this
  codebase should not be betting a 500 on.
* **Cost.** No cap. A pasted paragraph becomes a 5,000-branch `OR`, which is not a search.

Both now use `src/server/repositories/fts-query.ts`, which extracts word runs, caps at 32 terms
and returns `null` when nothing searchable survives. Extraction rather than escaping means
every metacharacter is gone before a quote is added, so the quoting is belt-and-braces rather
than the defence.

**The `null` case is the one that mattered.** File search read `if (match) push(...)`, so a
query of `***` dropped the text filter entirely and returned every file the actor could see —
the user asked one question and was shown the answer to another. It now returns no results,
matching `experiment.repository.d1.ts` and matching what MongoDB `$text` does with a term that
tokenizes to nothing.

## 6. D1 binds at most 100 parameters per statement

The largest finding in this module, and it was already reachable in shipped code.

Several comments across the D1 layer were written against SQLite's compile-time
`SQLITE_MAX_VARIABLE_NUMBER`, whose default is 999 — `MAX_BOUND_IDS = 500` in the file-version
repository, `MAX_ACTOR_PRINCIPALS = 200` in `visibility.d1.ts`, and the note above the file
hierarchy checker's sub-select. **D1's limit is 100**, measured against the real engine:

```
 99 → ok      101 → D1_ERROR: too many SQL variables
100 → ok      102 → D1_ERROR: too many SQL variables
```

It was found by a test written for something else. `starredIdsAmong` chunked its ids at 100 —
correct arithmetic against the wrong limit, and wrong anyway, because the statement also binds
the user id and the entity type, making 102.

That is a terrible property for a limit to have. The ceiling depends on how many *other*
parameters the same statement happens to bind, so it is invisible in review — the `IN` list
looks bounded by the page size and the visibility predicate binding another forty parameters is
three files away — and it moves when an unrelated predicate gains a parameter.

### What was actually broken

| Path | List | Reachable how |
|---|---|---|
| `findByIds` → `hydrate` | up to 200 star ids, then 4 more `IN` queries | **Starred page, at 100 starred files** |
| `hydrate` on a listing | one page of file ids | a folder at the maximum page size |
| `actorPrincipalIds` in every visibility predicate | actor + department + projects + **every role** | a user on ~90 projects — and it breaks *every* listing at once, not one page |
| `purgeForFiles`, `findByIdsInternal`, folder purge | a purge batch | retention job |

### The fix

`src/server/db/d1-bindings.ts` exports `inList`, which renders

```sql
column IN (SELECT value FROM json_each(?))
```

binding the whole list as **one** JSON parameter. List length stops interacting with the
parameter budget entirely: there is no chunk size to tune and no arithmetic to get wrong when a
predicate changes.

It is not a pessimisation. `EXPLAIN QUERY PLAN` on the rewritten form still shows
`SEARCH … USING COVERING INDEX (id=?)`, with the JSON array driving a `LIST SUBQUERY` — the same
access path the parameter list produced.

Applied across all eight D1 repositories and `visibility.d1.ts`. Drizzle's `inArray` is kept for
the one form that takes a *sub-query* rather than a value list (the file hierarchy checker),
which already binds nothing per row, and would be appropriate for a list fixed in the source.

An empty list yields a predicate matching **nothing**, deliberately. The alternative some query
builders take — omitting the clause — turns "none of these" into "all of them", which on a
permission-filtered read is a disclosure rather than a bug.

## 7. Verification

`tests/d1/search-lifecycle.test.ts` and `tests/d1/bound-parameter-limit.test.ts`, plus the
corrected-behaviour tests added to the Mongo suite.

### What the D1 suites prove

**Stars.** Adding three times leaves one row *with its original timestamp*; two people starring
one file get a row each and unstarring one does not touch the other; a folder and a file sharing
an id stay separate; `starredIdsAmong` answers for one user only.

**Recent.** `touch` upserts rather than appends and moves the item to the top with its action
refreshed; a re-touch does not rewrite `organization_id`; histories do not cross between users.

**Saved searches.** Every method — `findOwned`, `update`, `remove`, `markRun` — is exercised
against *another user's* row and returns `null`/`false` rather than throwing, because a distinct
error for "exists but not yours" would itself be the disclosure. Saving twice under one name
replaces rather than duplicating, case-folded; two people may keep a search under the same name;
`markRun` increments in the statement, so three concurrent runs count three; an unparseable
`criteria` blob yields `{}` rather than making the whole list un-openable.

**The FTS builder**, against real FTS5 rather than against the regex — what matters is that
SQLite accepts the output. Seventeen hostile inputs including `NEAR`, `^anchor`, `col:value`,
`x" OR files_fts MATCH "y`, `'; DROP TABLE files; --`, an unbalanced quote, an emoji and
`Müller`. Plus the two behavioural rules: unsearchable text is *no results, never no filter*,
and terms are OR-ed rather than AND-ed to match `$text`.

**The lifecycle views return files**, not only folders — the regression the UI shipped once,
asserted at the repository. Trash lists a directly-deleted file and not one swept in with its
parent; a hidden row is excluded from the trash **total** as well as the page.

**The parameter limit**, measured rather than remembered, and every caller-sized read driven
past it with 150 ids: `findByIds` including all four hydration queries, `findByIdsInternal`,
`starredIdsAmong`, both purge hooks, folder `findByIdsInternal`, version storage locations and
purge, and a listing by an actor carrying 150 principals.

### Gates

| Gate | Command | Result |
|---|---|---|
| Module suite | `vitest run --config vitest.d1.config.ts tests/d1/search-lifecycle.test.ts` | 35 passed |
| Parameter limit | `vitest run --config vitest.d1.config.ts tests/d1/bound-parameter-limit.test.ts` | 10 passed |
| Full D1 suite | `npm run test:d1` | recorded in `FINAL-READINESS.md` §3.1 |
| Full Mongo suite | `npm run test:mongo` | recorded in `FINAL-READINESS.md` §3.1 |
| Typecheck / lint | `npm run typecheck`, `npm run lint` | clean |

## 8. Rollback

Revert the commits. `DATA_SOURCE_SEARCH` is unset, so all three façades return the MongoDB
implementations.

Three changes are **not** behind the flag and are the ones to weigh:

* the Mongo aggregate fix, which changes two live dashboard figures — deliberately, and it is
  the corrected behaviour;
* the shared FTS builder, which changes D1 file search only (`DATA_SOURCE_FILES=d1`, unset in
  production);
* `inList`, which changes generated SQL across the D1 repositories and is covered by the full
  D1 suite.
