import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import {
  consume,
  consumeLocal,
  enforce,
  reset,
  resetAllRateLimits,
  setRateLimiterNamespaceForTesting,
  RATE_LIMITS,
  type RateLimiterNamespace,
} from '@/server/auth/rate-limit';
import { RateLimiter } from '@/server/auth/rate-limiter.durable-object';
import { RateLimitError } from '@/server/errors/app-error';
import { setRuntimeOverride } from '@/server/runtime';

beforeEach(() => resetAllRateLimits());
afterEach(() => {
  setRateLimiterNamespaceForTesting(null);
  setRuntimeOverride(null);
});

describe('rate limiting (in-process store)', () => {
  const rule = { limit: 3, windowMs: 60_000 };

  it('allows up to the limit and then blocks', () => {
    const now = Date.now();
    expect(consumeLocal('k', rule, now).allowed).toBe(true);
    expect(consumeLocal('k', rule, now).allowed).toBe(true);
    expect(consumeLocal('k', rule, now).allowed).toBe(true);

    const blocked = consumeLocal('k', rule, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts each key independently', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) consumeLocal('a', rule, now);
    expect(consumeLocal('a', rule, now).allowed).toBe(false);
    expect(consumeLocal('b', rule, now).allowed).toBe(true);
  });

  it('opens a new window once the old one expires', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) consumeLocal('k', rule, now);
    expect(consumeLocal('k', rule, now).allowed).toBe(false);
    expect(consumeLocal('k', rule, now + rule.windowMs + 1).allowed).toBe(true);
  });

  it('enforce throws a RateLimitError carrying Retry-After', async () => {
    for (let i = 0; i < 3; i += 1) await enforce('k', rule);
    const error = await enforce('k', rule).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).status).toBe(429);
    expect((error as RateLimitError).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reset clears a counter after a successful sign-in', async () => {
    for (let i = 0; i < 3; i += 1) await consume('k', rule);
    expect((await consume('k', rule)).allowed).toBe(false);
    await reset('k');
    expect((await consume('k', rule)).allowed).toBe(true);
  });

  it('ships sensible defaults for the authentication endpoints', () => {
    expect(RATE_LIMITS.login.limit).toBeLessThanOrEqual(10);
    expect(RATE_LIMITS.loginPerEmail.limit).toBeLessThanOrEqual(5);
    expect(RATE_LIMITS.passwordResetPerEmail.limit).toBeLessThanOrEqual(3);
  });
});

/**
 * The Worker path: every isolate asks the same Durable Object, so the count is shared. Simulated
 * with real `RateLimiter` instances (one per key, as `idFromName` gives) over in-memory storage,
 * and the in-process Map cleared between calls to stand in for requests landing on different
 * isolates.
 */
function durableNamespace() {
  const objects = new Map<string, RateLimiter>();
  const storageFor = () => {
    const data = new Map<string, unknown>();
    return {
      get: async (key: string) => data.get(key),
      put: async (key: string, value: unknown) => void data.set(key, value),
      deleteAll: async () => data.clear(),
      setAlarm: async () => undefined,
    };
  };
  const namespace: RateLimiterNamespace = {
    idFromName: (name) => name,
    get: (id) => {
      const name = id as string;
      if (!objects.has(name)) {
        objects.set(name, new RateLimiter({ storage: storageFor() } as unknown as DurableObjectState));
      }
      const object = objects.get(name)!;
      return { fetch: (input, init) => object.fetch(new Request(input, init)) };
    },
  };
  return namespace;
}

describe('rate limiting on a Worker (Durable Object store)', () => {
  const rule = { limit: 3, windowMs: 60_000 };

  it('counts across isolates: the limit holds even when no isolate sees every request', async () => {
    setRuntimeOverride('workerd');
    setRateLimiterNamespaceForTesting(durableNamespace());

    for (let i = 0; i < 3; i += 1) {
      resetAllRateLimits(); // a different isolate each time: its own Map is empty
      expect((await consume('login:ip:203.0.113.9', rule)).allowed).toBe(true);
    }
    resetAllRateLimits();
    const error = await enforce('login:ip:203.0.113.9', rule).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RateLimitError);
  });

  it('reset clears the shared counter', async () => {
    setRuntimeOverride('workerd');
    setRateLimiterNamespaceForTesting(durableNamespace());
    for (let i = 0; i < 4; i += 1) await consume('login:email:a@company.com', rule);
    await reset('login:email:a@company.com');
    expect((await consume('login:email:a@company.com', rule)).allowed).toBe(true);
  });

  it('still counts, in-isolate, when the Durable Object is unreachable', async () => {
    setRuntimeOverride('workerd');
    setRateLimiterNamespaceForTesting({
      idFromName: (name) => name,
      get: () => ({ fetch: vi.fn(async () => { throw new Error('network'); }) }),
    });
    for (let i = 0; i < 3; i += 1) expect((await consume('k', rule)).allowed).toBe(true);
    expect((await consume('k', rule)).allowed).toBe(false);
  });
});
