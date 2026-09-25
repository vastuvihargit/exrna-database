/**
 * `detach` — fire-and-forget that a Worker cannot silently cancel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detach } from '@/server/runtime/detach';

const CONTEXT = Symbol.for('__cloudflare-context__');
const holder = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
  delete holder[CONTEXT];
});

describe('detach', () => {
  it('registers the work with waitUntil when a Cloudflare request context is present', async () => {
    const waitUntil = vi.fn();
    holder[CONTEXT] = { ctx: { waitUntil } };

    detach(Promise.resolve('done'), 'test.write');

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBe('done');
  });

  it('never lets a failure escape as an unhandled rejection, on either runtime', async () => {
    const waitUntil = vi.fn();
    holder[CONTEXT] = { ctx: { waitUntil } };
    detach(Promise.reject(new Error('write refused')), 'test.write');
    // The registered promise has the failure handled (and logged) rather than rejecting.
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();

    delete holder[CONTEXT];
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    detach(Promise.reject(new Error('node write refused')), 'test.write');
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
