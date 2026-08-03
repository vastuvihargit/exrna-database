/**
 * Fixed-window rate limiting.
 *
 * In-process for the MVP (single application node — assumption A9). The interface is
 * deliberately async and keyed by string so a Redis implementation can replace the
 * store without touching call sites.
 *
 * Note: this is the second layer. Nginx already applies coarse per-IP limits; this one
 * knows about accounts and endpoints.
 */
import { RateLimitError } from '@/server/errors/app-error';

export interface RateLimitRule {
  /** Max requests permitted inside the window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Counter {
  count: number;
  resetAt: number;
}

const counters = new Map<string, Counter>();
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

export function consume(key: string, rule: RateLimitRule, now = Date.now()): RateLimitResult {
  sweep(now);

  const existing = counters.get(key);
  if (!existing || existing.resetAt <= now) {
    counters.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > rule.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  return { allowed: true, remaining: rule.limit - existing.count, retryAfterSeconds: 0 };
}

/** Consume one unit or throw a 429 carrying Retry-After. */
export function enforce(key: string, rule: RateLimitRule, now = Date.now()): void {
  const result = consume(key, rule, now);
  if (!result.allowed) {
    throw new RateLimitError(result.retryAfterSeconds, 'Too many attempts. Please try again later.');
  }
}

/** Clears a counter after a successful authentication, so one bad day is not punitive. */
export function reset(key: string): void {
  counters.delete(key);
}

/** Test-only: drop all counters. */
export function resetAllRateLimits(): void {
  counters.clear();
}
