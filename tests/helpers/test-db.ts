/**
 * Shared in-memory MongoDB harness for integration and security suites.
 *
 * Uses a single-node replica set because the application relies on transactions.
 * If the binary cannot be provisioned (offline host), `available` is false and the
 * suites skip loudly rather than passing silently.
 */
import type { MongoMemoryReplSet } from 'mongodb-memory-server';

export interface TestDb {
  available: boolean;
  reason?: string;
  uri?: string;
}

let replSet: MongoMemoryReplSet | null = null;

export async function startTestDb(): Promise<TestDb> {
  try {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    const uri = replSet.getUri();

    process.env.MONGODB_URI = uri;
    process.env.MONGODB_DATABASE = 'biotech_drive_test';

    const { resetEnvCache } = await import('@/server/config/env');
    resetEnvCache();

    const { connectToDatabase } = await import('@/server/db/connection');
    await connectToDatabase();

    const { syncAllIndexes } = await import('@/server/db/models');
    await syncAllIndexes();

    return { available: true, uri };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[tests] In-memory MongoDB unavailable, skipping database suites: ${reason}`);
    return { available: false, reason };
  }
}

export async function stopTestDb(): Promise<void> {
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => undefined);
  if (replSet) {
    await replSet.stop();
    replSet = null;
  }
}

/** Empties every collection between tests so suites cannot leak state into each other. */
export async function clearCollections(): Promise<void> {
  const mongoose = (await import('mongoose')).default;
  const collections = await mongoose.connection.db?.collections();
  if (!collections) return;
  for (const collection of collections) {
    await collection.deleteMany({});
  }
}
