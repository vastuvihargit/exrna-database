/**
 * How a variable-length list of ids reaches a D1 statement.
 *
 * ── The problem this exists to remove ───────────────────────────────────────────────────
 *
 * **D1 refuses any statement with more than 100 bound parameters.** Not 999 — SQLite's
 * compile-time `SQLITE_MAX_VARIABLE_NUMBER` default, which several comments in this codebase
 * were written against — but 100, measured against the real engine and pinned by
 * `tests/d1/bound-parameter-limit.test.ts`.
 *
 * A `WHERE id IN (?, ?, …)` built from an application list therefore has a ceiling that
 * depends on how many *other* parameters the same statement happens to bind. That is a
 * terrible property for a limit to have:
 *
 *   • it is invisible in code review — the `IN` list looks bounded by the page size, and the
 *     visibility predicate that binds another forty parameters is three files away;
 *   • it moves when an unrelated predicate gains a parameter;
 *   • it fails as `D1_ERROR: too many SQL variables`, an opaque 500 on an ordinary page.
 *
 * And it was already reachable. `listStarred` fetches up to 200 star ids and hands them
 * straight to `findByIds`; a drive folder at the maximum page size hydrates 100 files. Both
 * are over the line.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────────────────
 *
 * `IN (SELECT value FROM json_each(?))` binds the whole list as **one** parameter — a JSON
 * array — so list length stops interacting with the parameter budget entirely. There is no
 * chunk size to tune and no arithmetic to get wrong when a predicate changes.
 *
 * It is not a pessimisation. `EXPLAIN QUERY PLAN` for the rewritten form still shows
 * `SEARCH … USING COVERING INDEX (id=?)` with the JSON array driving a `LIST SUBQUERY`, which
 * is the same access path the parameter list produced.
 *
 * ── When to use which ───────────────────────────────────────────────────────────────────
 *
 * Use `inList` whenever the list length is decided by a caller — a page of ids, an actor's
 * principals, a purge batch. Keep Drizzle's `inArray` for lists that are fixed in the source
 * (a status enum, two drive types): those cannot grow, and `inArray` reads better.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * The measured ceiling. Exported so tests can assert against the number rather than a
 * comment, and so a future engine change is a one-line edit with a failing test attached.
 */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * `column IN (<values>)`, as a single bound parameter.
 *
 * An empty list yields a predicate that matches nothing. That is the correct reading of "in
 * this empty set" and it matters: the alternative some query builders take — omitting the
 * clause — turns "none of these" into "all of them", which on a permission-filtered read is a
 * disclosure rather than a bug. Callers that want to skip the query entirely still should,
 * for the round trip, but they cannot get the *wrong answer* by forgetting to.
 */
export function inList(column: SQLiteColumn | SQL, values: readonly string[]): SQL {
  if (values.length === 0) return sql`0 = 1`;
  return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
}
