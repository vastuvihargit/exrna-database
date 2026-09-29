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
import { isWorkerRuntime } from '@/server/runtime';

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

/**
 * Used by /api/health/ready and the admin System page. Never leaks the connection string.
 *
 * In a Worker the application's database is D1 and MongoDB is unreachable by construction, so
 * pinging Mongo there would report every healthy Worker as down — the first thing an operator
 * reads after a deploy. The Worker answer is a round trip through the D1 binding.
 */
export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const started = Date.now();
  if (isWorkerRuntime()) {
    try {
      const { getD1Binding } = await import('./d1-context');
      await (await getD1Binding()).prepare('SELECT 1').first();
      return { status: 'ok', latencyMs: Date.now() - started, database: 'd1' };
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : 'D1 unavailable' };
    }
  }
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
 *
 * ── In a Worker there is no MongoDB session to open ─────────────────────────────────────
 *
 * Several services wrap work in this helper and branch *inside* it on the D1 engine, where the
 * atomicity comes from a D1 `batch()` (`createVersionWithFile`, the lifecycle and hierarchy
 * units of work) and the Mongo session is ignored. On Node that costs an unused session. In a
 * Worker it was fatal: `connectToDatabase()` needs a TCP socket workerd does not have, so the
 * upload, new-version, file move / trash / restore and approval-integrity paths would all have
 * failed after cutover — with every module correctly on D1. A Worker therefore runs the callback
 * with no session; every module there is on D1 (`loadWorkerEnv` refuses a production Worker
 * otherwise), and every D1 repository ignores the session argument.
 */
export async function withTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  if (isWorkerRuntime()) {
    // The callback's parameter stays typed as a session so the ~20 Node call sites are
    // unchanged; nothing on the D1 path dereferences it.
    return fn(undefined as unknown as mongoose.ClientSession);
  }

  await connectToDatabase();
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => fn(session));
  } finally {
    await session.endSession();
  }
}
