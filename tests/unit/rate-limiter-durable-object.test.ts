/**
 * The Worker's rate-limit counter, driven through its real `fetch` protocol against an
 * in-memory stand-in for Durable Object storage.
 *
 * What matters here is that the Durable Object and the in-process store agree (they share
 * `applyFixedWindow`), that a window is cleaned up by its alarm, and that a malformed request
 * cannot write a nonsense rule into a counter.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import { RateLimiter } from '@/server/auth/rate-limiter.durable-object';
import type { RateLimitResult } from '@/server/auth/rate-limit-window';

function fakeState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: unknown) => void data.set(key, value)),
    deleteAll: vi.fn(async () => data.clear()),
    setAlarm: vi.fn(async (at: number) => void (alarm = at)),
  };
  return { state: { storage } as unknown as DurableObjectState, data, alarmAt: () => alarm };
}

const RULE = { limit: 3, windowMs: 60_000 };

async function consume(limiter: RateLimiter, rule: unknown = RULE): Promise<Response> {
  return limiter.fetch(new Request('https://rate-limiter/consume', { method: 'POST', body: JSON.stringify(rule) }));
}

describe('RateLimiter Durable Object', () => {
  it('allows up to the limit, then refuses with a Retry-After', async () => {
    const { state } = fakeState();
    const limiter = new RateLimiter(state);

    for (let i = 0; i < 3; i += 1) {
      const result = (await (await consume(limiter)).json()) as RateLimitResult;
      expect(result.allowed).toBe(true);
    }
    const blocked = (await (await consume(limiter)).json()) as RateLimitResult;
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('opens a new window after the old one ends', async () => {
    vi.useFakeTimers();
    try {
      const { state } = fakeState();
      const limiter = new RateLimiter(state);
      for (let i = 0; i < 4; i += 1) await consume(limiter);
      vi.setSystemTime(Date.now() + RULE.windowMs + 1);
      const result = (await (await consume(limiter)).json()) as RateLimitResult;
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(RULE.limit - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sets an alarm for the end of the window, and the alarm deletes the expired counter', async () => {
    vi.useFakeTimers();
    try {
      const { state, data, alarmAt } = fakeState();
      const limiter = new RateLimiter(state);
      await consume(limiter);
      expect(alarmAt()).toBeGreaterThan(Date.now() + RULE.windowMs - 1);

      // Before the window ends the alarm keeps the counter.
      await limiter.alarm();
      expect(data.size).toBe(1);

      vi.setSystemTime(Date.now() + RULE.windowMs + 1);
      await limiter.alarm();
      expect(data.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset clears the counter', async () => {
    const { state } = fakeState();
    const limiter = new RateLimiter(state);
    for (let i = 0; i < 4; i += 1) await consume(limiter);
    const reset = await limiter.fetch(new Request('https://rate-limiter/reset', { method: 'POST' }));
    expect(reset.status).toBe(204);
    const result = (await (await consume(limiter)).json()) as RateLimitResult;
    expect(result.allowed).toBe(true);
  });

  it('refuses a malformed rule without touching the counter', async () => {
    const { state, data } = fakeState();
    const limiter = new RateLimiter(state);
    for (const bad of [null, {}, { limit: 0, windowMs: 1000 }, { limit: 5, windowMs: -1 }, { limit: 1.5, windowMs: 10 }]) {
      expect((await consume(limiter, bad)).status).toBe(400);
    }
    expect(data.size).toBe(0);
  });

  it('answers only POST /consume and POST /reset', async () => {
    const { state } = fakeState();
    const limiter = new RateLimiter(state);
    expect((await limiter.fetch(new Request('https://rate-limiter/consume'))).status).toBe(405);
    expect((await limiter.fetch(new Request('https://rate-limiter/other', { method: 'POST' }))).status).toBe(404);
  });
});
