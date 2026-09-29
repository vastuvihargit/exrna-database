# Phase 3, module 12 — the audit trail on D1

**Status: complete.** Append and query, behind a contract, routed by `DATA_SOURCE_AUDIT_LOGS`.
§6 records the verification. Nothing here is enabled in production.

---

## 1. The smallest module, and the one with the strongest guarantee

Two methods. `append` and `query`. There is deliberately no update and no delete on the
interface, and adding one would be a change to the *security posture* rather than to a
repository.

Immutability is defended in three layers, and only the middle one lives in this module:

1. the engine refuses it — Mongoose pre-hooks on MongoDB; on D1, `trg_audit_logs_no_update` and
   `trg_audit_logs_no_delete`, `RAISE(ABORT)` triggers created in migration 0001 alongside the
   ones on `stock_transactions`;
2. **the contract has no method that could be called to rewrite a row**;
3. in production the database user has insert and find on this collection only.

Layer 1 is what makes the guarantee hold against something that is *not* this file — a migration
script, an admin console, a future repository written by someone who did not read the comment.
So it is tested directly against the engine: the suite issues an `UPDATE` and a `DELETE` and
asserts both are refused *and* that the row is unchanged, because a trigger that aborted after
the write would be worse than no trigger at all.

There is likewise **no TTL and no retention index** on either engine. Retention is applied by an
explicit, audited archival job, never silently by the database.

## 2. A consequence: `append` cannot be idempotent

Making a retried append idempotent would mean an upsert; an upsert is an update; an update is
the thing the triggers exist to refuse.

So a retry writes a second row, and that is the correct failure mode. Two records of one attempt
is a reporting nuisance. One record silently overwritten is evidence destroyed. The behaviour is
pinned by a test so nobody "fixes" it later.

## 3. Success events are recorded after the business commit

The requirement is that a rolled-back write must not leave a "success" behind.

`audit.service.ts` accepts an optional Mongoose session, and **no caller passes one** — every
call site records after its transaction has returned. On D1 the session parameter cannot be
honoured at all (it is a Mongo object and governs no D1 statement), so the ordering rule is the
whole mechanism, and the append is deliberately *not* part of anyone's batch.

That trade is worth stating explicitly rather than leaving implicit. "Audit after commit" can
lose an audit row if the process dies in the gap; it can never invent one for a write that did
not happen. Losing evidence of something that happened is recoverable from the business record.
Inventing evidence of something that did not is not.

## 4. Redaction is shared policy, not per-engine code

`sanitizeAuditValue` lives in the contract and both implementations call it, because "what must
never be written to a log" is a rule about the product, not about the engine — and two copies of
it would eventually disagree about one key.

The list contains the credentials you would expect, plus two that are easy to miss:
`storageKey` and `relativeStoragePath`. An auditor allowed to know *that* a file changed is not
thereby allowed to know where its bytes live.

`Date` is passed through the redaction walk untouched. A pass that turned every date into `{}`
would quietly destroy the timestamps a "before" snapshot exists to preserve.

Payloads over 16 KiB serialized are replaced by `{ truncated: true, bytes }` rather than stored.

## 5. D1 specifics

**JSON columns.** `previous_value`, `new_value` and `actor_role_keys` are TEXT holding JSON,
because the before/after snapshot is `Mixed` in Mongo and is read whole. They are parsed
defensively: an unparseable payload yields `null` rather than throwing, because one malformed
row must not break the page an administrator opens *because* something went wrong.

**`organization_id` is nullable, deliberately.** A failed login against an address matching no
account belongs to no tenant, and dropping the row would erase exactly what credential stuffing
looks like in the trail. `query` always filters by a specific organization, so those rows are
reachable only by system-level tooling reading the table directly — asserted by a test that
writes one and then finds it invisible to both tenants while confirming it is genuinely there.

**The id tiebreak in the ordering is not decoration.** Several records of one request share a
timestamp to the millisecond, and without `ORDER BY created_at DESC, id DESC` paging skips one
row and repeats another. The test walks five single-row pages and asserts five distinct ids.

## 6. Verification

`tests/d1/audit-log-repository.test.ts` — **19 tests, all passing** against real D1.

Immutability against the engine (UPDATE refused and row unchanged, DELETE refused, retry
duplicates rather than overwrites); organization isolation in the rows *and* the total, plus the
tenant-less event visible to nobody; filtering by action, outcome, entity, actor and time
window; five-page walk proving stable order; JSON round trip; deep redaction through nested
arrays and objects; oversized payload truncation; dates surviving redaction; a corrupted payload
read as `null` rather than failing the page; defaults for a background job's sparse event; and
the flag routing, Mongo until asked for D1 by name.

### Gates

| Gate | Result |
|---|---|
| `tests/d1/audit-log-repository.test.ts` | 19 passed |
| Full D1 and Mongo suites | recorded in the Phase 2 document's gate table, run together |
| Typecheck / lint | clean |

## 7. Rollback

Revert the commits. `DATA_SOURCE_AUDIT_LOGS` is unset and the façade returns MongoDB.

This module routes on its own and needs no companion flag: the audit trail references nothing
and nothing references it, so a record written to D1 while files are still on Mongo is complete
and readable. It is the only Phase 3 module with no cross-module write ordering to preserve.

One reporting fact to plan for rather than discover: moving the flag makes the admin audit page
show D1 records only. The Mongo collection is not deleted — it is the rollback path and the
historical record — so the Phase 9 migration copies it across rather than leaving a gap.
