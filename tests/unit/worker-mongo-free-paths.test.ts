/**
 * Request paths a Worker serves must not reach for MongoDB.
 *
 * Three were found doing so after every module had a D1 repository: `withTransaction` opened a
 * Mongo session around blocks whose D1 branch never used it (upload finalize, new version, file
 * move / trash / restore), the Drive mirror queried Mongoose models directly, and the health
 * check pinged Mongo. In a Worker each of those fails — the first two on a user's action, the
 * third on every readiness probe.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { D1Database } from '@cloudflare/workers-types';
import { setRuntimeOverride } from '@/server/runtime';
import { checkDatabaseHealth, withTransaction } from '@/server/db/connection';
import { setD1BindingForTesting } from '@/server/db/d1-context';

afterEach(() => {
  setRuntimeOverride(null);
  setD1BindingForTesting(null);
  vi.restoreAllMocks();
});

describe('in a Worker', () => {
  it('withTransaction runs the callback without opening a MongoDB session', async () => {
    setRuntimeOverride('workerd');
    const connect = vi.spyOn(mongoose, 'connect');
    const startSession = vi.spyOn(mongoose, 'startSession');

    const result = await withTransaction(async (session) => {
      expect(session).toBeUndefined();
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(connect).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it('the database health check is a D1 round trip, not a Mongo ping', async () => {
    setRuntimeOverride('workerd');
    const first = vi.fn(async () => ({ 1: 1 }));
    setD1BindingForTesting({ prepare: vi.fn(() => ({ first })) } as unknown as D1Database);

    expect(await checkDatabaseHealth()).toMatchObject({ status: 'ok', database: 'd1' });
    expect(first).toHaveBeenCalled();
  });

  it('reports a D1 failure as an error rather than throwing', async () => {
    setRuntimeOverride('workerd');
    setD1BindingForTesting({
      prepare: () => ({ first: async () => { throw new Error('D1_ERROR: unavailable'); } }),
    } as unknown as D1Database);

    expect(await checkDatabaseHealth()).toEqual({ status: 'error', error: 'D1_ERROR: unavailable' });
  });
});

describe('the Drive mirror', () => {
  it('reads through repositories, never Mongoose models', async () => {
    const source = await fsp.readFile(
      path.resolve(process.cwd(), 'src/server/services/storage-migration/drive-mirror.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/@\/server\/db\/models/);
    expect(source).not.toMatch(/connectToDatabase/);
  });
});
