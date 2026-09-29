/**
 * `D1_LOCAL_PROXY_PERSIST` — the E2E suite's local D1 for a `next dev` server — can never reach
 * a deployed environment.
 *
 *   • On a Worker it is ignored: the binding comes from Cloudflare, full stop.
 *   • On Node it works only under `next dev` / tests (`NODE_ENV` development or test). A
 *     production or staging Node server with the variable set refuses, loudly, instead of
 *     quietly opening a local SQLite file and serving it as the database.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { D1BindingUnavailableError, getD1Binding } from '@/server/db/d1-context';
import { setRuntimeOverride } from '@/server/runtime';

const original = { persist: process.env.D1_LOCAL_PROXY_PERSIST, nodeEnv: process.env.NODE_ENV };

afterEach(() => {
  setRuntimeOverride(null);
  vi.doUnmock('@opennextjs/cloudflare');
  if (original.persist === undefined) delete process.env.D1_LOCAL_PROXY_PERSIST;
  else process.env.D1_LOCAL_PROXY_PERSIST = original.persist;
  (process.env as Record<string, string | undefined>).NODE_ENV = original.nodeEnv;
});

describe('D1_LOCAL_PROXY_PERSIST', () => {
  it.each(['production', 'staging'])('is refused by a %s Node server', async (nodeEnv) => {
    setRuntimeOverride('node');
    (process.env as Record<string, string>).NODE_ENV = nodeEnv;
    process.env.D1_LOCAL_PROXY_PERSIST = '/tmp/should-never-open/v3';

    await expect(getD1Binding()).rejects.toBeInstanceOf(D1BindingUnavailableError);
    await expect(getD1Binding()).rejects.toThrow(/development setting/);
  });

  it('is ignored on a Worker, which takes the binding from Cloudflare', async () => {
    setRuntimeOverride('workerd');
    process.env.D1_LOCAL_PROXY_PERSIST = '/tmp/should-never-open/v3';
    const binding = { prepare: vi.fn() };
    vi.doMock('@opennextjs/cloudflare', () => ({ getCloudflareContext: () => ({ env: { DB: binding } }) }));

    await expect(getD1Binding()).resolves.toBe(binding);
  });
});
