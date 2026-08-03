import { beforeEach, describe, expect, it } from 'vitest';
import { consume, enforce, reset, resetAllRateLimits, RATE_LIMITS } from '@/server/auth/rate-limit';
import { RateLimitError } from '@/server/errors/app-error';

beforeEach(() => resetAllRateLimits());

describe('rate limiting', () => {
  const rule = { limit: 3, windowMs: 60_000 };

  it('allows up to the limit and then blocks', () => {
    const now = Date.now();
    expect(consume('k', rule, now).allowed).toBe(true);
    expect(consume('k', rule, now).allowed).toBe(true);
    expect(consume('k', rule, now).allowed).toBe(true);

    const blocked = consume('k', rule, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts each key independently', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) consume('a', rule, now);
    expect(consume('a', rule, now).allowed).toBe(false);
    expect(consume('b', rule, now).allowed).toBe(true);
  });

  it('opens a new window once the old one expires', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) consume('k', rule, now);
    expect(consume('k', rule, now).allowed).toBe(false);
    expect(consume('k', rule, now + rule.windowMs + 1).allowed).toBe(true);
  });

  it('enforce throws a RateLimitError carrying Retry-After', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) enforce('k', rule, now);
    try {
      enforce('k', rule, now);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).status).toBe(429);
      expect((error as RateLimitError).retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('reset clears a counter after a successful sign-in', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) consume('k', rule, now);
    expect(consume('k', rule, now).allowed).toBe(false);
    reset('k');
    expect(consume('k', rule, now).allowed).toBe(true);
  });

  it('ships sensible defaults for the authentication endpoints', () => {
    expect(RATE_LIMITS.login.limit).toBeLessThanOrEqual(10);
    expect(RATE_LIMITS.loginPerEmail.limit).toBeLessThanOrEqual(5);
    expect(RATE_LIMITS.passwordResetPerEmail.limit).toBeLessThanOrEqual(3);
  });
});
