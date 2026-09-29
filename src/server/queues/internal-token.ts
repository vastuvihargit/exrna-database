/**
 * The credential that lets the Worker entrypoint hand a queue message to the Next.js bundle.
 *
 * ── Why a route at all ──────────────────────────────────────────────────────────────────
 *
 * The consumers need the application: repositories, flags, the Drive client, the logger. Those
 * live in the OpenNext-built server bundle, which aliases the dependencies a Worker cannot load.
 * Importing them a second time into the entrypoint would bundle a second, un-aliased copy of the
 * server. So the entrypoint calls the Next handler in-process with an internal request, and the
 * route runs the consumer inside the bundle like any other request.
 *
 * ── Why that is not an open endpoint ────────────────────────────────────────────────────
 *
 * The token is a random value generated inside the isolate on first use and kept on
 * `globalThis`. It never leaves the process: it is not an environment variable, not a secret in
 * Cloudflare's store, not in a response. A request from the internet cannot present it, so the
 * route answers every external call with 404. On Node the token is never set and the route is
 * permanently 404.
 */
const TOKEN_KEY = Symbol.for('biotech-drive.internal-queue-token');

export const INTERNAL_QUEUE_HEADER = 'x-internal-queue-token';
export const INTERNAL_QUEUE_PATH = '/api/internal/queues';

type TokenHolder = Record<symbol, string | undefined>;

/** Worker entrypoint only. Lazy, because workerd forbids random values at global scope. */
export function ensureInternalQueueToken(): string {
  const holder = globalThis as unknown as TokenHolder;
  holder[TOKEN_KEY] ??= crypto.randomUUID() + crypto.randomUUID();
  return holder[TOKEN_KEY] as string;
}

export function internalQueueToken(): string | null {
  return (globalThis as unknown as TokenHolder)[TOKEN_KEY] ?? null;
}
