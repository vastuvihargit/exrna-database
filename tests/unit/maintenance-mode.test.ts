/**
 * The cutover window's write freeze and maintenance modes, enforced in front of every API route.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { resetEnvCache } from '@/server/config/env';
import { withRouteHandler } from '@/server/http/route-handler';

function setMode(mode?: string): void {
  if (mode) process.env.MAINTENANCE_MODE = mode;
  else delete process.env.MAINTENANCE_MODE;
  resetEnvCache();
}

const handler = withRouteHandler(async () => new Response('handled', { status: 200 }));

async function call(method: string, path: string): Promise<number> {
  const response = await handler(new NextRequest(`http://localhost:3000${path}`, { method }), undefined);
  return response.status;
}

afterEach(() => setMode());

describe('MAINTENANCE_MODE', () => {
  it('changes nothing by default', async () => {
    expect(await call('POST', '/api/folders')).toBe(200);
  });

  it('read_only: reads work, writes and new sessions are refused, sign-out still works', async () => {
    setMode('read_only');
    expect(await call('GET', '/api/files/abc')).toBe(200);
    expect(await call('POST', '/api/folders')).toBe(503);
    expect(await call('PATCH', '/api/files/abc')).toBe(503);
    expect(await call('DELETE', '/api/files/abc')).toBe(503);
    expect(await call('POST', '/api/auth/login')).toBe(503);
    expect(await call('GET', '/api/auth/access')).toBe(503);
    expect(await call('POST', '/api/internal/queues')).toBe(503);
    expect(await call('POST', '/api/auth/logout')).toBe(200);
  });

  it('maintenance: everything but health answers 503', async () => {
    setMode('maintenance');
    expect(await call('GET', '/api/files/abc')).toBe(503);
    expect(await call('GET', '/api/health')).toBe(200);
    expect(await call('GET', '/api/health/ready')).toBe(200);
  });

  it('refuses an unknown mode at startup rather than guessing', async () => {
    const { loadEnv } = await import('@/server/config/env');
    expect(() => loadEnv({ ...process.env, MAINTENANCE_MODE: 'readonly' })).toThrow(/MAINTENANCE_MODE/);
  });
});
