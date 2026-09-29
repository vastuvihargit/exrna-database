/**
 * The D1 connection and the replacement for `withTransaction`.
 *
 * `connection.ts` remains the MongoDB connection and is untouched — both databases are live
 * side by side until Phase 7, and this file is what Phase 3 repositories will import as they
 * move across one module at a time.
 *
 * ── There are no interactive transactions ───────────────────────────────────────────────
 *
 * `withTransaction()` in `connection.ts` gives a callback a session it can read *and* write
 * through, deciding what to write next based on what it just read. D1 has no equivalent, and
 * pretending otherwise is the single most likely way to silently lose an invariant in this
 * migration. `db.batch()` sends one atomic list of statements — all commit or none do — but
 * the list is fixed before the first one runs, so nothing in it can branch on a prior result.
 *
 * The 25 `withTransaction` call sites fall into three shapes, and each needs a different
 * answer. `docs/cloudflare-migration/00-phase-0-analysis.md` §4.10 has the table; the helpers
 * below are the two mechanical cases.
 */
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { BatchItem } from 'drizzle-orm/batch';
/**
 * Imported as a type rather than pulled in globally — see the same note in `env.worker.ts`.
 * Adding `@cloudflare/workers-types` to `tsconfig.json`'s `types` array would redefine
 * `fetch`, `Request` and `Response` for all 118 route handlers.
 */
import type { D1Database } from '@cloudflare/workers-types';
import { schema } from './schema';

export type Database = DrizzleD1Database<typeof schema>;

/**
 * Wraps a D1 binding.
 *
 * Deliberately takes the binding rather than reaching for it: in a Worker the binding comes
 * off the request's execution context, and a module-scope lookup would either capture the
 * wrong one or fail outright. Phase 3 threads it through the repository layer explicitly.
 */
export function createDatabase(binding: D1Database): Database {
  return drizzle(binding, { schema });
}

/**
 * Atomic multi-statement write — the direct replacement for a `withTransaction` block whose
 * statements do not read each other.
 *
 * D1 runs the whole list in one implicit transaction and rolls back entirely on any failure,
 * which is exactly the guarantee the Mongo session gave for this shape: "create the file, the
 * version and the counter bump, or none of them".
 */
export async function withBatch<T extends BatchItem<'sqlite'>[]>(
  db: Database,
  statements: [...T],
): Promise<unknown[]> {
  if (statements.length === 0) return [];
  return db.batch(statements as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

/**
 * Optimistic concurrency for the read-decide-write shape.
 *
 * Where Mongo held a lock for the duration of the callback, D1 gets the same safety by making
 * the write conditional on the row not having moved: the UPDATE carries the `updated_at` the
 * caller read, and affects zero rows if somebody else got there first. The caller re-reads
 * and retries.
 *
 * `attempts` is small on purpose. Contention here means two people are editing the same
 * folder or version at the same moment, which is rare and self-resolving; a long retry loop
 * would turn a rare conflict into a slow request.
 */
export async function withOptimisticRetry<T>(
  operation: () => Promise<T | null>,
  { attempts = 3, label = 'operation' }: { attempts?: number; label?: string } = {},
): Promise<T> {
  let lastResult: T | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastResult = await operation();
    if (lastResult !== null) return lastResult;
  }

  throw new Error(
    `${label} could not be applied after ${attempts} attempts because the record kept changing ` +
      'underneath it. This usually means two people edited the same item at once.',
  );
}

export type D1Health =
  | { status: 'ok'; latencyMs: number }
  | { status: 'error'; error: string };

/** Used by /api/health/ready. Never leaks a binding or a query. */
export async function checkD1Health(binding: D1Database): Promise<D1Health> {
  const started = Date.now();
  try {
    await binding.prepare('SELECT 1').first();
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown database error',
    };
  }
}
