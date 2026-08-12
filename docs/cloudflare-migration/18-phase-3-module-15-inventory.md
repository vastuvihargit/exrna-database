# Phase 3, module 15 — inventory, batches and the stock ledger

**Status: complete.** Items, batches and stock movement have D1 implementations behind a
contract, and stock movement — which had never been implemented on *either* engine — now exists.
§7 records the verification. Nothing here is enabled in production.

---

## 1. Two things at once

This module closed two different gaps that happened to live in the same place.

* **A migration gap.** `inventory-item` was one of the last repositories with no D1
  implementation, and it is reached from the inventory pages, so it blocked a Worker.
* **A feature gap.** The brief's Phase 5 asks for add-stock, issue-stock,
  employee/department/project/experiment linkage, no-over-issue and immutable history. The
  service handled item *definitions* only and said so; the receipt, issue and adjustment paths
  it referred to did not exist, on MongoDB either.

Doing them separately would have meant migrating a repository and then immediately rewriting it,
so they are one module.

## 2. The contract is stock operations, not batch rows

The obvious contract — `addBatch`, `decrementBatch`, `updateSummary` — would let a service
decrement a batch and then fail before writing the ledger row. The material would be gone from
the count with nothing recording where it went, which is the single outcome an inventory system
exists to prevent.

So the unit of work is the operation a store manager actually performs: `receive`, `issue`,
`adjust`, `expire`. Each one moves stock **and** appends its ledger row, or does neither. There
is no signature through which a caller could forget, and neither engine can be the one that
"skips the transaction".

## 3. Negative stock is prevented by the engine

A check-then-decrement in application code has a window, and the window is exactly the case that
matters: two people issuing the last of a reagent at the same moment. Both read 5, both decide 3
is fine, and the shelf owes 1.

### 3.1 D1 — `CHECK`, inside one `batch()`

`batch()` *is* a transaction: the whole list commits or none of it does. That is sufficient here
because a stock operation never needs to branch on what it just read — `planIssue` decides which
batches and how much from each before the first statement runs.

Every decrement is therefore unconditional arithmetic:

```sql
UPDATE inventory_batches SET quantity = quantity - ? WHERE item_id = ? AND batch_number = ?
```

and `CHECK (quantity >= 0)` aborts it if it would overdraw. The abort rolls the entire operation
back, ledger row included.

**A conditional `WHERE quantity >= ?` would also prevent the overdraw, and was rejected.** It
prevents it *silently*: the statement affects no rows, the ledger insert still runs, and the
system records an issue that never happened. Failing loudly is the point.

### 3.2 MongoDB — the check inside the retried transaction

The availability check is a plain comparison, sound because of where it sits: inside the
transaction, against a document read inside the same transaction. Two concurrent issues write the
same document, so the second raises a write conflict and `session.withTransaction` retries it —
re-running the callback from the top, so the loser re-reads the decremented quantity.

An earlier version used `updateOne` + `arrayFilters` + `modifiedCount === 0`. It read
convincingly and did not work: the driver reports the parent document as matched, so an issue
that changed nothing reported success. **A test caught it**, which is the argument for testing the
concurrency case rather than reasoning about it.

## 4. The ledger's before/after figures are computed by the database

`previousQuantity` and `newQuantity` are what an auditor reads to confirm the counter never
drifted. Computing them in JavaScript from a value read a moment earlier defeats their purpose:
two concurrent issues of 3 from a stock of 10 would both record "10 → 7" while the item correctly
reached 4. Every row would look plausible and the set would be wrong.

Both implementations derive them from the row *after* the decrement — a correlated subquery on
D1, the `{ new: true }` document on MongoDB.

The test that pins this issues ten times concurrently and then walks the ledger sorted by the
counter each row left behind, asserting every row's `previousQuantity` equals the previous row's
`newQuantity`. A single-row assertion would pass against the broken implementation.

## 5. Two deliberate divergences between the engines

### 5.1 D1 keeps zero-quantity batch rows; MongoDB prunes them

MongoDB prunes because batches live in an embedded array that has to stay bounded
(`MAX_BATCHES_PER_ITEM`). A D1 batch is a row, and rows are cheap.

Keeping them is load-bearing rather than lazy. If a concurrent issue could *delete* a row that
another operation is about to decrement, that decrement would find nothing, affect zero rows,
raise no CHECK — and the ledger would over-report. With the row always present, the CHECK is the
only possible outcome.

The record returned to callers still hides empty batches, so the contract surface matches: an
empty container is not stock.

### 5.2 A negative D1 adjustment uses `UPDATE`, not the upsert

SQLite validates CHECK constraints on the candidate row **before** it resolves the UNIQUE
conflict, so an upsert carrying `quantity = -3` trips `ck_inventory_batches_quantity` and aborts —
even though the `DO UPDATE` branch would have produced a legal positive value. The failure looks
exactly like an overdraw, which is what made it worth finding by test rather than by reasoning.

A negative adjustment therefore uses a plain UPDATE, which is sound because the batch is required
to exist: `UnknownBatchError` is thrown first if it does not.

## 6. Expired stock is refused, not skipped

`planIssue` never allocates from an expired batch, so an item holding 10 L of which 8 L expired
refuses a 5 L issue **while still reporting 10 L in stock**.

Both halves matter. The refusal stops somebody running an assay with reagent that expired last
month. The stock figure staying at 10 keeps the discrepancy visible until it is written off,
rather than quietly reconciling a difference between the system and the shelf.

The error message distinguishes "not enough stock" from "not enough *issuable* stock", because
the remedies are different — one is a reorder, the other is a write-off — and they look identical
to somebody reading a screen that says 10 L available.

## 7. Verification

| Gate | Result |
|---|---|
| `tests/d1/inventory-repository.test.ts` | **59 tests, both engines, passed** |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npx next build` | passed |

The suite is aimed at the silent failures rather than the happy paths: the concurrency winner,
the ledger chain under ten racers, "a failed movement leaves no ledger row", the wildcard search
term treated as a literal, the soft-deleted item excluded from the dashboard aggregate (the same
Mongoose `aggregate` bypass that made `searchFacets` count trashed files), and append-only
enforced at *both* engines — the Mongoose pre-hooks and the migration 0001 `RAISE(ABORT)`
triggers.

## 8. A cutover blocker found on the way

`objectIdSchema` accepted only 24 hex characters. Every D1 repository mints
`crypto.randomUUID()`.

Switching any module to D1 would therefore have made every resource created afterwards
unreachable through its own API — 238 call sites returning 422 "Invalid identifier" from routes
that never touched the database. `_shared.ts` already documents both id shapes coexisting by
design; the validator had simply never been told.

Widened to accept either shape, keeping the anchored fixed-length character-restricted check.
That check is load-bearing in two places and was not weakened: `Types.ObjectId.isValid()` returns
true for *any* 12-character string, and the repository layer branches on it to return `null`, so
a value that is neither shape reaching that branch turns a malformed request into a 404.

## 9. Flag dependencies

`DATA_SOURCE_INVENTORY` covers items, batches *and* the ledger — one flag, because they are one
transaction and there is no engine in which half of an issue can live somewhere else.

Its dependency list gained `projects`, `experiments` and `files`: `stock_transactions` references
all three as real foreign keys, because recording what material was consumed *for* is the point
of the feature rather than an optional label.
