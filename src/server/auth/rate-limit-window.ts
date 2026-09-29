/**
 * The fixed-window arithmetic, on its own.
 *
 * Shared by the in-process store (Node, tests) and the Durable Object store (Worker), so the
 * two cannot disagree about what "the eleventh attempt in fifteen minutes" means. Pure: no
 * clock, no storage, no runtime imports — the caller supplies `now` and keeps the state.
 */

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

export interface WindowState {
  count: number;
  resetAt: number;
}

/** Counts one attempt against `state` and says whether it is allowed. */
export function applyFixedWindow(
  state: WindowState | null | undefined,
  rule: RateLimitRule,
  now: number,
): { next: WindowState; result: RateLimitResult } {
  if (!state || state.resetAt <= now) {
    return {
      next: { count: 1, resetAt: now + rule.windowMs },
      result: { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 },
    };
  }

  const next = { count: state.count + 1, resetAt: state.resetAt };
  if (next.count > rule.limit) {
    return {
      next,
      result: {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((state.resetAt - now) / 1000)),
      },
    };
  }

  return { next, result: { allowed: true, remaining: rule.limit - next.count, retryAfterSeconds: 0 } };
}
