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

/**
 * Development and E2E only: a *local* D1 for a Node dev server.
 *
 * `next dev` is a Node process, which normally has no D1 at all. Setting `D1_LOCAL_PROXY_PERSIST`
 * to a directory gives it one through wrangler's platform proxy — the same Miniflare/workerd
 * SQLite `wrangler dev --local` uses, persisted where the variable says. That is what lets the
 * browser E2E suite drive the real UI against real D1 repositories.
 *
 * The value is wrangler's *state* directory (the `v3` folder), as `getPlatformProxy` takes it —
 * so `wrangler d1 migrations apply --persist-to X` pairs with `D1_LOCAL_PROXY_PERSIST=X/v3`.
 *
 * Refused unless `NODE_ENV` is `development` or `test`: a deployed Node server is the MongoDB
 * deployment, and a Worker ignores the variable entirely (its binding comes from Cloudflare).
 * There is no path by which this reaches a deployed environment
 * (`tests/unit/d1-local-proxy-guard.test.ts`).
 *
 * Held on `globalThis`, not in a module variable: `next dev` compiles every route into its own
 * module graph, so a module-level cache starts one proxy — one `workerd` process — per route
 * compiled, until the machine runs out of commit memory. One proxy per Node process.
 */
const LOCAL_PROXY_KEY = Symbol.for('biotech-drive.d1-local-proxy');
type ProxyHolder = { [LOCAL_PROXY_KEY]?: Promise<D1Database> };

async function localProxyBinding(persistPath: string): Promise<D1Database> {
  // An allow-list, not a deny-list: `staging` or any unexpected value is a deployed server too.
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new D1BindingUnavailableError(
      `D1_LOCAL_PROXY_PERSIST is a development setting and is refused when NODE_ENV is "${nodeEnv ?? ''}".`,
    );
  }
  const holder = globalThis as ProxyHolder;
  holder[LOCAL_PROXY_KEY] ??= (async () => {
    // Imported by a computed name so no bundler ever pulls wrangler into the application.
    const wranglerModule = ['wr', 'angler'].join('');
    const { getPlatformProxy } = (await import(/* webpackIgnore: true */ wranglerModule)) as {
      getPlatformProxy: (options: Record<string, unknown>) => Promise<{ env: Record<string, unknown> }>;
    };
    const proxy = await getPlatformProxy({
      environment: 'development',
      persist: { path: persistPath },
      envFiles: [],
    });
    const binding = proxy.env.DB as D1Database | undefined;
    if (!binding) throw new D1BindingUnavailableError('The local platform proxy has no DB binding.');
    return binding;
  })();
  return holder[LOCAL_PROXY_KEY];
}

export async function getD1Binding(): Promise<D1Database> {
  if (injected) return injected;

  if (!isWorkerRuntime() && process.env.D1_LOCAL_PROXY_PERSIST) {
    return localProxyBinding(process.env.D1_LOCAL_PROXY_PERSIST);
  }

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
