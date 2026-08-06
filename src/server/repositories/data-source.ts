/**
 * Which database backs each module, one module at a time.
 *
 * Phase 3 moves 10 modules from MongoDB to D1. Moving them in a single commit would mean a
 * single revert for any one of them, so each module carries its own switch and each can be
 * turned back independently while the other nine stay where they are.
 *
 * ── Why this reads `process.env` directly ───────────────────────────────────────────────
 *
 * `env.ts` (Node) and `env.worker.ts` (Worker) are two schemas, and a flag that decides which
 * *database* is live must not be able to differ between them — two definitions is two things
 * that can disagree, and the disagreement here would be "staging reads D1, production reads
 * Mongo" discovered from a support ticket. `wrangler.jsonc` sets
 * `nodejs_compat_populate_process_env`, so `process.env` is the one lookup that means the same
 * thing in both runtimes.
 *
 * ── Default ─────────────────────────────────────────────────────────────────────────────
 *
 * `mongo`, for every module, always. An unset variable, a typo'd value and a misspelled
 * module name all resolve to the database that is currently serving production. The only way
 * to read D1 is to ask for it by name.
 */

/**
 * Every module in the Phase 3 plan, in migration order.
 *
 * Listed in full from the start so the flag surface is fixed before the modules land, and so
 * `dataSourceSummary()` reports the ones still on Mongo rather than silently omitting them.
 */
export const DATA_SOURCE_MODULES = [
  'users',
  'departments',
  'roles',
  'projects',
  'experiments',
  'folders',
  'files',
  'fileVersions',
  'search',
  'reviews',
  'auditLogs',
  'inventory',
  'notifications',
] as const;

export type DataSourceModule = (typeof DATA_SOURCE_MODULES)[number];

export const DATA_SOURCES = ['mongo', 'd1'] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

/** `users` → `DATA_SOURCE_USERS`, `fileVersions` → `DATA_SOURCE_FILE_VERSIONS`. */
export function envVarFor(module: DataSourceModule): string {
  return `DATA_SOURCE_${module.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

const overrides = new Map<DataSourceModule, DataSource>();

/**
 * Test-only. A suite that exercises the D1 repository sets this rather than mutating
 * `process.env`, which vitest shares across files in the same worker.
 */
export function setDataSourceOverride(module: DataSourceModule, source: DataSource | null): void {
  if (source === null) overrides.delete(module);
  else overrides.set(module, source);
}

export function clearDataSourceOverrides(): void {
  overrides.clear();
}

export function dataSourceFor(module: DataSourceModule): DataSource {
  const override = overrides.get(module);
  if (override) return override;

  const raw = process.env[envVarFor(module)];
  // Anything other than an exact match falls back to Mongo. A typo must not silently move a
  // module onto a database that has not been verified for it.
  return raw === 'd1' ? 'd1' : 'mongo';
}

export function isD1(module: DataSourceModule): boolean {
  return dataSourceFor(module) === 'd1';
}

/** For `/api/health/ready` and the Phase 6 migration report. Never shown to normal users. */
export function dataSourceSummary(): Record<DataSourceModule, DataSource> {
  return Object.fromEntries(
    DATA_SOURCE_MODULES.map((module) => [module, dataSourceFor(module)]),
  ) as Record<DataSourceModule, DataSource>;
}
