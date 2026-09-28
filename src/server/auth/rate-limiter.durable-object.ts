/**
 * The Worker's rate-limit counter: one Durable Object per key.
 *
 * ── Why not the in-process Map ──────────────────────────────────────────────────────────
 *
 * A Worker is many isolates, in many locations, each with its own memory. A counter kept in
 * module scope counts the requests that happened to land on one isolate, so "5 sign-in attempts
 * per 15 minutes" silently becomes "5 per isolate" — a limit that mostly does not exist. A
 * Durable Object has exactly one instance per id, everywhere, and handles its requests one at a
 * time, so the count is exact.
 *
 * ── Why not the Workers Rate Limiting binding ───────────────────────────────────────────
 *
 * It accepts a period of 10 or 60 seconds and is approximate per location. The rules this
 * application enforces run over 5 to 60 minutes (`RATE_LIMITS`), and the sign-in ones are the
 * reason rate limiting exists at all.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────────────────
 *
 * `idFromName(key)` — one small object per `login:ip:…`, `api:user:…`, etc. Each holds a single
 * `{count, resetAt}` record and sets an alarm for the end of its window that deletes it, so
 * idle keys cost nothing. Exported from `cloudflare-worker.ts`; bound as `RATE_LIMITER`.
 *
 * The `fetch` interface (rather than RPC) keeps this file free of `cloudflare:workers`, which the
 * Node type environment cannot resolve. The protocol is private to `rate-limit.ts`:
 *
 *   POST /consume  {"limit": n, "windowMs": n}  →  RateLimitResult
 *   POST /reset                                 →  204
 */
import type { DurableObjectState } from '@cloudflare/workers-types';
import { applyFixedWindow, type RateLimitRule, type WindowState } from './rate-limit-window';

const KEY = 'window';

function isRule(value: unknown): value is RateLimitRule {
  const rule = value as Partial<RateLimitRule> | null;
  return (
    typeof rule?.limit === 'number' && Number.isInteger(rule.limit) && rule.limit > 0 &&
    typeof rule.windowMs === 'number' && Number.isInteger(rule.windowMs) && rule.windowMs > 0
  );
}

export class RateLimiter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return new Response(null, { status: 405 });

    if (path === '/reset') {
      await this.state.storage.deleteAll();
      return new Response(null, { status: 204 });
    }

    if (path === '/consume') {
      const rule: unknown = await request.json().catch(() => null);
      if (!isRule(rule)) return new Response('invalid rule', { status: 400 });

      const now = Date.now();
      const current = await this.state.storage.get<WindowState>(KEY);
      const { next, result } = applyFixedWindow(current, rule, now);
      await this.state.storage.put(KEY, next);
      // A new window: clean it up when it ends, so an idle key leaves nothing behind.
      if (!current || current.resetAt !== next.resetAt) await this.state.storage.setAlarm(next.resetAt + 1_000);
      return Response.json(result);
    }

    return new Response(null, { status: 404 });
  }

  async alarm(): Promise<void> {
    const current = await this.state.storage.get<WindowState>(KEY);
    if (!current || current.resetAt <= Date.now()) await this.state.storage.deleteAll();
  }
}
