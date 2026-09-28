/**
 * Fixed-window rate limiting, with a store chosen by runtime.
 *
 *   • **Node** (the legacy deployment, tests, `next dev`): an in-process Map. The Node
 *     deployment is a single application process, so a process-wide count is the whole count.
 *   • **Cloudflare Worker**: the `RATE_LIMITER` Durable Object, one object per key
 *     (`rate-limiter.durable-object.ts`). A Worker is many isolates in many locations; a Map
 *     there would count one isolate's share of the traffic, and "5 sign-in attempts per 15
 *     minutes" would silently become "5 per isolate". The Durable Object's count is exact.
 *
 * Both stores run the same arithmetic (`rate-limit-window.ts`), so they cannot disagree about
 * what the limit means.
 *
 * ── Not silently ineffective ────────────────────────────────────────────────────────────
 *
 * The Worker refuses to start without the `RATE_LIMITER` binding (`assertBindings`), so a Worker
 * that reaches this code has one. If a call to the object itself fails — a transient platform
 * error — the attempt is still counted, in the isolate's own Map, and the failure is logged at
 * error level. That is a weaker limit for the length of an outage, never no limit at all, and it
 * never turns a platform hiccup into every user being refused sign-in.
 *
 * Nginx / Cloudflare's edge still applies coarse per-IP limits in front; this layer knows about
 * accounts and endpoints.
 */
import { RateLimitError } from '@/server/errors/app-error';
import { getLogger } from '@/server/logging/logger';
import { isWorkerRuntime } from '@/server/runtime';
import {
  applyFixedWindow,
  type RateLimitResult,
  type RateLimitRule,
  type WindowState,
} from './rate-limit-window';

export type { RateLimitResult, RateLimitRule } from './rate-limit-window';

export const RATE_LIMITS = {
  login: { limit: 10, windowMs: 15 * 60_000 },
  loginPerEmail: { limit: 5, windowMs: 15 * 60_000 },
  passwordResetPerEmail: { limit: 3, windowMs: 60 * 60_000 },
  passwordResetPerIp: { limit: 10, windowMs: 60 * 60_000 },
  authenticated: { limit: 1000, windowMs: 15 * 60_000 },

  /**
   * Upload authorization — the step that reserves a quarantine slot and a quota
   * allocation before a single byte is sent.
   *
   * The general authenticated limit is far too loose for this: 1000 requests could open
   * 1000 upload sessions, each holding disk and quota until it expires. 300 in ten
   * minutes still comfortably covers dragging a folder of several hundred files in, which
   * is the largest legitimate burst this endpoint sees.
   */
  uploadAuthorize: { limit: 300, windowMs: 10 * 60_000 },

  /**
   * Search. Every query is a text-index scan filtered by permission, which is the most
   * expensive read in the system — and a scripted search loop is also how somebody would
   * probe for filenames they cannot open.
   */
  search: { limit: 120, windowMs: 5 * 60_000 },
} as const satisfies Record<string, RateLimitRule>;

/* ------------------------------------------------------------------ in-process store */

const counters = new Map<string, WindowState>();
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

/** Drops expired counters so the map cannot grow without bound under a flood. */
function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, counter] of counters) {
    if (counter.resetAt <= now) counters.delete(key);
  }
}

/** The in-process count. Synchronous; `now` is injectable for tests. */
export function consumeLocal(key: string, rule: RateLimitRule, now = Date.now()): RateLimitResult {
  sweep(now);
  const { next, result } = applyFixedWindow(counters.get(key), rule, now);
  counters.set(key, next);
  return result;
}

/* ------------------------------------------------------------------ Durable Object store */

/** The subset of a Durable Object namespace this module uses. Keeps workers-types out of `src`. */
export interface RateLimiterNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

const CLOUDFLARE_CONTEXT = Symbol.for('__cloudflare-context__');
let injectedNamespace: RateLimiterNamespace | null = null;

/** Test-only: hand in a namespace double, so the Worker path runs without workerd. */
export function setRateLimiterNamespaceForTesting(namespace: RateLimiterNamespace | null): void {
  injectedNamespace = namespace;
}

function durableNamespace(): RateLimiterNamespace | null {
  if (injectedNamespace) return injectedNamespace;
  if (!isWorkerRuntime()) return null;
  const context = (globalThis as Record<symbol, { env?: Record<string, unknown> } | undefined>)[
    CLOUDFLARE_CONTEXT
  ];
  const binding = context?.env?.RATE_LIMITER as RateLimiterNamespace | undefined;
  return binding && typeof binding.idFromName === 'function' ? binding : null;
}

async function callObject(
  namespace: RateLimiterNamespace,
  key: string,
  path: '/consume' | '/reset',
  body?: RateLimitRule,
): Promise<Response> {
  const stub = namespace.get(namespace.idFromName(key));
  // The host is ignored by the object; it only needs to be a valid URL.
  return stub.fetch(`https://rate-limiter${path}`, {
    method: 'POST',
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
}

/* ------------------------------------------------------------------ public API */

/** Counts one attempt against `key` in whichever store this runtime uses. */
export async function consume(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
  const namespace = durableNamespace();
  if (!namespace) {
    if (isWorkerRuntime()) {
      // Unreachable in a correctly started Worker: `assertBindings` requires RATE_LIMITER.
      getLogger().error({ key }, 'RATE_LIMITER binding missing on a Worker; counting in-isolate only');
    }
    return consumeLocal(key, rule);
  }

  try {
    const response = await callObject(namespace, key, '/consume', rule);
    if (!response.ok) throw new Error(`rate limiter answered ${response.status}`);
    return (await response.json()) as RateLimitResult;
  } catch (error) {
    getLogger().error(
      { key, err: error instanceof Error ? error.message : String(error) },
      'Rate limiter unavailable; counting in-isolate for this request',
    );
    return consumeLocal(key, rule);
  }
}

/** Consume one unit or throw a 429 carrying Retry-After. */
export async function enforce(key: string, rule: RateLimitRule): Promise<void> {
  const result = await consume(key, rule);
  if (!result.allowed) {
    throw new RateLimitError(result.retryAfterSeconds, 'Too many attempts. Please try again later.');
  }
}

/** Clears a counter after a successful authentication, so one bad day is not punitive. */
export async function reset(key: string): Promise<void> {
  counters.delete(key);
  const namespace = durableNamespace();
  if (!namespace) return;
  try {
    await callObject(namespace, key, '/reset');
  } catch (error) {
    // Not clearing a counter is harmless: it expires with its window.
    getLogger().warn({ key, err: error instanceof Error ? error.message : String(error) }, 'Rate limiter reset failed');
  }
}

/** Test-only: drop all in-process counters. */
export function resetAllRateLimits(): void {
  counters.clear();
}
