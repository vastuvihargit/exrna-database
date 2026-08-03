/**
 * MongoDB connection.
 *
 * A single pooled connection is cached on globalThis so Next.js hot reloads (which
 * re-evaluate modules) do not open a new pool on every edit and exhaust the server's
 * connection limit.
 */
import mongoose, { type Connection } from 'mongoose';
import { getEnv } from '@/server/config/env';
import { getLogger } from '@/server/logging/logger';

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

const globalWithMongoose = globalThis as typeof globalThis & {
  __biotechDriveMongoose?: MongooseCache;
};

const cache: MongooseCache = (globalWithMongoose.__biotechDriveMongoose ??= {
  conn: null,
  promise: null,
});

/**
 * NoSQL injection is prevented at the boundary, not here: every input is parsed by a
 * strict Zod schema before it reaches a repository, so `{"email": {"$ne": null}}` is a
 * 422 rather than a query operator (tests/security/authentication.test.ts).
 *
 * Mongoose's global `sanitizeFilter` is deliberately NOT enabled — it wraps every
 * object-valued filter in `$eq`, which breaks the application's own legitimate
 * operators (`$gt` on expiry dates, `$in` on id lists) and would silently turn
 * correct queries into ones that match nothing.
 */
mongoose.set('strictQuery', true);

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;

  if (!cache.promise) {
    const env = getEnv();
    const log = getLogger();

    cache.promise = mongoose
      .connect(env.MONGODB_URI, {
        dbName: env.MONGODB_DATABASE,
        maxPoolSize: 20,
        minPoolSize: 2,
        serverSelectionTimeoutMS: 10_000,
        socketTimeoutMS: 60_000,
        retryWrites: true,
        // Index creation is driven explicitly by syncIndexes() in scripts, not implicitly
        // on first query — implicit builds are a production foot-gun.
        autoIndex: false,
      })
      .then((m) => {
        log.info({ database: env.MONGODB_DATABASE }, 'MongoDB connected');
        return m;
      })
      .catch((error: unknown) => {
        cache.promise = null;
        log.error({ err: error }, 'MongoDB connection failed');
        throw error;
      });
  }

  cache.conn = await cache.promise;
  return cache.conn;
}

export async function disconnectFromDatabase(): Promise<void> {
  if (cache.conn) {
    await cache.conn.disconnect();
    cache.conn = null;
    cache.promise = null;
  }
}

export function getConnection(): Connection {
  return mongoose.connection;
}

export type DatabaseHealth =
  | { status: 'ok'; latencyMs: number; database: string }
  | { status: 'error'; error: string };

/** Used by /api/health/ready. Never leaks the connection string. */
export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const started = Date.now();
  try {
    await connectToDatabase();
    const admin = mongoose.connection.db?.admin();
    if (!admin) throw new Error('No active database handle');
    await admin.command({ ping: 1 });
    return {
      status: 'ok',
      latencyMs: Date.now() - started,
      database: mongoose.connection.name,
    };
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown database error',
    };
  }
}

/**
 * Multi-document transaction helper.
 *
 * Requires a replica set (a single-node rs0 is enough). Used wherever two collections
 * must agree — upload finalization, version restore, approval, folder move.
 */
export async function withTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  await connectToDatabase();
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => fn(session));
  } finally {
    await session.endSession();
  }
}
