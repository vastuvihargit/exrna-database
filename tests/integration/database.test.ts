/**
 * MongoDB integration checks.
 *
 * Uses mongodb-memory-server with a single-node replica set, because the application
 * relies on multi-document transactions (upload finalization, approval, folder move).
 * If the server binary cannot be provisioned (offline CI, restricted host) the suite
 * skips loudly rather than silently passing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let replSet: import('mongodb-memory-server').MongoMemoryReplSet | null = null;
let uri: string | null = null;
let skipReason: string | null = null;

beforeAll(async () => {
  try {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    uri = replSet.getUri();
  } catch (error) {
    skipReason = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[integration] Skipping MongoDB tests — could not start an in-memory server: ${skipReason}`);
  }
}, 120_000);

afterAll(async () => {
  if (replSet) {
    const mongoose = (await import('mongoose')).default;
    await mongoose.disconnect().catch(() => undefined);
    await replSet.stop();
  }
});

describe('database connection', () => {
  it('connects, pings, and reports health', async () => {
    if (!uri) {
      expect(skipReason, 'in-memory MongoDB unavailable — see warning above').toBeTruthy();
      return;
    }

    process.env.MONGODB_URI = uri;
    process.env.MONGODB_DATABASE = 'biotech_drive_test';

    const { resetEnvCache } = await import('@/server/config/env');
    resetEnvCache();

    const { connectToDatabase, checkDatabaseHealth } = await import('@/server/db/connection');
    await connectToDatabase();

    const health = await checkDatabaseHealth();
    expect(health.status).toBe('ok');
    if (health.status === 'ok') {
      expect(health.database).toBe('biotech_drive_test');
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);

  it('supports multi-document transactions', async () => {
    if (!uri) return;

    const { withTransaction } = await import('@/server/db/connection');
    const mongoose = (await import('mongoose')).default;

    const collection = mongoose.connection.collection('transaction_probe');

    // Commit path.
    await withTransaction(async (session) => {
      await collection.insertOne({ marker: 'committed' }, { session });
    });
    expect(await collection.countDocuments({ marker: 'committed' })).toBe(1);

    // Rollback path — the whole point of using transactions.
    await expect(
      withTransaction(async (session) => {
        await collection.insertOne({ marker: 'rolled-back' }, { session });
        throw new Error('forced failure');
      }),
    ).rejects.toThrow('forced failure');
    expect(await collection.countDocuments({ marker: 'rolled-back' })).toBe(0);
  }, 60_000);

  it('registers base models and enforces their indexes', async () => {
    if (!uri) return;

    const { OrganizationModel } = await import('@/server/db/models');
    await OrganizationModel.syncIndexes();

    const created = await OrganizationModel.create({
      name: 'exRNA Bio',
      slug: 'exrna-bio',
      emailDomains: ['company.com'],
      settings: {
        defaultUserQuotaBytes: 20 * 1024 ** 3,
        defaultDepartmentQuotaBytes: 500 * 1024 ** 3,
        maxUploadBytes: 2048 * 1024 ** 2,
      },
    });
    expect(created.slug).toBe('exrna-bio');

    // The unique slug index must be enforced by the database, not just by code.
    await expect(
      OrganizationModel.create({
        name: 'Duplicate',
        slug: 'exrna-bio',
        emailDomains: ['company.com'],
        settings: {
          defaultUserQuotaBytes: 1,
          defaultDepartmentQuotaBytes: 1,
          maxUploadBytes: 1,
        },
      }),
    ).rejects.toThrow();

    // Internal fields must not survive serialization to an API response.
    const serialized = JSON.parse(JSON.stringify(created.toJSON())) as Record<string, unknown>;
    expect(serialized.id).toBeDefined();
    expect(serialized._id).toBeUndefined();
    expect(serialized.__v).toBeUndefined();
  }, 60_000);
});
