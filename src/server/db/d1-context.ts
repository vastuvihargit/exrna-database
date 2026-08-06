/**
 * How a repository gets hold of the D1 binding.
 *
 * `d1.ts` deliberately takes the binding as an argument rather than reaching for it, because a
 * module-scope lookup in a Worker captures the wrong request's context. That leaves the
 * question this file answers: where does the caller get the binding from, given that no
 * service in this codebase threads a database handle through its arguments?
 *
 * Threading one through would mean changing the signature of every service and every route —
 * the "do not rebuild the project" rule rules it out, and it would make the Mongo and D1
 * paths structurally different, which is exactly what a reversible migration must avoid.
 *
 * So the binding is resolved per call, from the ambient request context:
 *
 *   • **Worker** — `getCloudflareContext().env.DB`, which OpenNext scopes to the in-flight
 *     request via AsyncLocalStorage. Correct by construction under concurrency.
 *   • **Tests** — an explicitly injected binding (see `setD1BindingForTesting`).
 *   • **Node server** — there is none, and that is not an error to paper over. The Node
 *     deployment has no D1; a module flagged `d1` there is a misconfiguration, and the thrown
 *     message says so rather than failing later as `undefined is not a function`.
 *
 * The import of `@opennextjs/cloudflare` is dynamic on purpose. It is a devDependency of the
 * Cloudflare build only, and a static import would put it in the Node bundle's module graph.
 */
import type { D1Database } from '@cloudflare/workers-types';
import { createDatabase, type Database } from './d1';
import { isWorkerRuntime } from '@/server/runtime';

let injected: D1Database | null = null;

/**
 * Test-only. Lets a suite hand in a Miniflare-backed D1 binding, so the repository tests run
 * against the real D1 engine in-process instead of shelling out to wrangler per statement.
 */
export function setD1BindingForTesting(binding: D1Database | null): void {
  injected = binding;
}

/**
 * Cached per binding rather than globally: `drizzle()` wraps one binding, and in a Worker the
 * binding object differs between requests. Keying on the binding means a Worker reuses the
 * wrapper for the life of that binding and a test that swaps bindings gets a fresh one.
 */
const wrappers = new WeakMap<D1Database, Database>();

function wrap(binding: D1Database): Database {
  const existing = wrappers.get(binding);
  if (existing) return existing;
  const database = createDatabase(binding);
  wrappers.set(binding, database);
  return database;
}

export class D1BindingUnavailableError extends Error {
  constructor(detail: string) {
    super(`The D1 database binding is not available. ${detail}`);
    this.name = 'D1BindingUnavailableError';
  }
}

export async function getD1Binding(): Promise<D1Database> {
  if (injected) return injected;

  if (!isWorkerRuntime()) {
    throw new D1BindingUnavailableError(
      'This process is the Node deployment, which has no D1. A module is configured with ' +
        'DATA_SOURCE_<MODULE>=d1 but can only be served from a Cloudflare Worker. Unset the ' +
        'variable to return that module to MongoDB.',
    );
  }

  const { getCloudflareContext } = await import('@opennextjs/cloudflare');
  const binding = (getCloudflareContext().env as { DB?: D1Database }).DB;

  if (!binding) {
    throw new D1BindingUnavailableError(
      'The Worker is running without a `DB` binding. Check the `d1_databases` block in ' +
        'wrangler.jsonc for this environment.',
    );
  }

  return binding;
}

/** What every D1 repository calls. */
export async function getD1(): Promise<Database> {
  return wrap(await getD1Binding());
}
