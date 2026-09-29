import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * `dialect: 'sqlite'` rather than `'turso'` or `'d1-http'`: migrations are generated as plain
 * SQL files and applied with `wrangler d1 migrations apply`, which is the path that works
 * identically for a local SQLite file, a preview database and production. The `d1-http`
 * driver would let drizzle-kit push directly to a remote D1, and that is exactly what should
 * not be possible for a production database holding research data — a migration reaches
 * production through wrangler and a reviewed SQL file, never from a developer's machine.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/db/schema/index.ts',
  out: './drizzle/migrations',
  // Every generated statement is reviewed before it is applied. `strict` makes drizzle-kit
  // ask before anything destructive; `verbose` prints the statements it intends to write.
  strict: true,
  verbose: true,
});
