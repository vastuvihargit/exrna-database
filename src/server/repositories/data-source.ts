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
 * Listed in full so `dataSourceSummary()` reports the ones still on Mongo rather than silently
 * omitting them.
 *
 * Every entry is read by a repository façade; `tests/unit/data-source-matrix.test.ts` fails
 * otherwise. `collaboration` and `jobs` were listed here once and named nothing — the
 * collaboration tables have their own flags (comments, reviews, notifications), and the job
 * tables belong to Node-only migration tools with no D1 repository. A switch that does nothing
 * is worse than none: see DATA-SOURCE-FLAGS.md §2.1.
 */
export const DATA_SOURCE_MODULES = [
  'organizations',
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
  'sessions',
  'loginHistory',
  'storageUsage',
  'activities',
  'comments',
  'driveSync',
  'uploadSessions',
  'appSettings',
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

/**
 * What the *deployment* is configured to do, ignoring test overrides.
 *
 * Separate from `dataSourceFor` because the two answer different questions, and conflating them
 * broke a suite. `dataSourceFor` answers "which repository should this call use right now",
 * which a test legitimately redirects per module. `configuredDataSourceFor` answers "how is this
 * environment set up", which is what the startup matrix check validates.
 *
 * A suite that deliberately puts folders on D1 and files on Mongo — to prove the hierarchy layer
 * *refuses* that combination with its own domain error — must not have the environment guard
 * throw first and pre-empt the assertion it was written to make.
 */
export function configuredDataSourceFor(module: DataSourceModule): DataSource {
  const raw = process.env[envVarFor(module)];
  // Anything other than an exact match falls back to Mongo. A typo must not silently move a
  // module onto a database that has not been verified for it.
  return raw === 'd1' ? 'd1' : 'mongo';
}

export function dataSourceFor(module: DataSourceModule): DataSource {
  const override = overrides.get(module);
  if (override) return override;
  return configuredDataSourceFor(module);
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

/* ────────────────────────────────────────────────────────────── the flag matrix ───────── */

/**
 * Which modules cannot be on D1 unless some other module is too.
 *
 * These are not preferences. Each entry is a **foreign key that exists in the D1 schema**: a
 * row in the dependent table cannot be inserted unless the referenced row is in the same
 * database. Splitting such a pair does not degrade gracefully — the dependent module's every
 * write fails with a constraint violation, at runtime, on a user's action.
 *
 * The list is deliberately about *writes crossing databases*, which is why it is much shorter
 * than "everything depends on everything". Modules that only exchange ids — a star naming a
 * file, a saved search naming a folder — are genuinely independent and are absent here; see the
 * note in `star.repository.ts`.
 *
 * `search` is the interesting absence. `stars`, `recent_items` and `saved_searches` all carry
 * `user_id` and `organization_id` foreign keys, so they do require identity on D1 — but they
 * are listed under `requires` for exactly that reason, not omitted.
 */
export const DATA_SOURCE_DEPENDENCIES: Partial<Record<DataSourceModule, DataSourceModule[]>> = {
  users: ['organizations'],
  departments: ['organizations'],
  roles: ['organizations', 'users'],
  projects: ['organizations', 'users', 'departments'],
  experiments: ['organizations', 'users', 'projects'],
  folders: ['organizations', 'users', 'departments'],
  files: ['organizations', 'users', 'folders'],
  fileVersions: ['organizations', 'users', 'files'],
  search: ['organizations', 'users'],
  reviews: ['organizations', 'users', 'files', 'fileVersions'],
  auditLogs: ['organizations', 'users'],
  /**
   * The item's own foreign keys, plus the ledger's.
   *
   * `stock_transactions` references `projects` and `experiments` because an issue records what
   * the material was consumed for — that linkage is the point of the feature, not an optional
   * label — and `files` because a delivery note is attached rather than copied.
   */
  inventory: ['organizations', 'users', 'departments', 'projects', 'experiments', 'files'],
  notifications: ['organizations', 'users'],
  sessions: ['organizations', 'users'],
  /** `login_history.user_id` and `.session_id` are both real foreign keys. */
  loginHistory: ['users', 'sessions'],
  /**
   * Writes counters on `users`, `departments` and `projects`, and derives them from
   * `file_versions.file_size`. An engine holding the counters but not the versions cannot
   * reconcile them — `recomputeAll` would zero every quota.
   */
  storageUsage: ['users', 'departments', 'projects', 'files', 'fileVersions'],
  /** `activity_folders.folder_id` is a real foreign key, as are the actor and project columns. */
  activities: ['organizations', 'users', 'folders', 'projects'],
  /** `comments.version_id` is a foreign key, so a comment cannot outrun its version. */
  comments: ['organizations', 'users', 'files', 'fileVersions'],
  /** `result_file_id` and `result_version_id` are foreign keys, as are the folder and owner. */
  uploadSessions: ['organizations', 'users', 'folders', 'files', 'fileVersions'],
  appSettings: ['organizations'],
};

export interface DataSourceViolation {
  module: DataSourceModule;
  requires: DataSourceModule;
  message: string;
}

/**
 * Everything a module transitively needs on D1.
 *
 * Resolved rather than hand-listed, because the direct edges are the ones that can be checked
 * against the schema and the transitive ones are the ones that get forgotten. `fileVersions`
 * names `files`; `files` names `folders`; `folders` names `departments`. An operator who set
 * only `DATA_SOURCE_FILE_VERSIONS=d1` should be told about all of them at once.
 *
 * The `seen` set makes this safe against a cycle in the table, which would otherwise be an
 * infinite loop at startup — a worse failure than the misconfiguration it is checking for.
 */
function transitiveRequirements(start: DataSourceModule): DataSourceModule[] {
  const seen = new Set<DataSourceModule>();
  const queue = [...(DATA_SOURCE_DEPENDENCIES[start] ?? [])];

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (next === start || seen.has(next)) continue;
    seen.add(next);
    queue.push(...(DATA_SOURCE_DEPENDENCIES[next] ?? []));
  }

  return [...seen];
}

/**
 * Modules that must be on the same engine in **both** directions.
 *
 * `DATA_SOURCE_DEPENDENCIES` catches a child on D1 with its parent on MongoDB — a foreign key
 * that cannot resolve. It does not catch the reverse, and for these groups the reverse is just
 * as broken: their multi-table writes are single D1 `batch()`es (`d1-unit-of-work.ts`,
 * `d1-review-unit-of-work.ts`), and those engines refuse to run half of one on each database.
 * Before this list that refusal happened on a user's folder move, upload or approval; now it
 * happens at startup, like every other matrix violation.
 */
export const DATA_SOURCE_MOVE_TOGETHER: ReadonlyArray<{ modules: DataSourceModule[]; why: string }> = [
  {
    modules: ['folders', 'files'],
    why: 'folder move, trash, restore and archive rewrite folders and the files under them in one D1 batch',
  },
  {
    modules: ['files', 'fileVersions'],
    why: 'an upload or new version writes the version row and the file pointing at it in one D1 batch',
  },
  {
    modules: ['reviews', 'files', 'fileVersions'],
    why: 'a review request or decision updates the review, the file and the exact version in one D1 batch',
  },
];

/**
 * Every unsafe split in the current configuration.
 *
 * Returns them all rather than the first, and resolves transitively, because an operator fixing
 * one flag per restart cycle is how a cutover window gets spent.
 */
export function dataSourceViolations(): DataSourceViolation[] {
  const violations: DataSourceViolation[] = [];
  // `configuredDataSourceFor`, not `isD1`: this validates the environment, not the routing a
  // test has redirected. See the note on that function.
  const onD1 = (name: DataSourceModule) => configuredDataSourceFor(name) === 'd1';

  // Named `name` rather than `module`: `module` is a reserved binding in a CommonJS scope and
  // the Next.js lint rule that catches it treats an assignment as an error, not a warning.
  for (const name of DATA_SOURCE_MODULES) {
    if (!onD1(name)) continue;
    for (const requirement of transitiveRequirements(name)) {
      if (onD1(requirement)) continue;
      violations.push({
        module: name,
        requires: requirement,
        message:
          `${envVarFor(name)}=d1 requires ${envVarFor(requirement)}=d1: rows reachable from ` +
          `the "${name}" tables carry a foreign key into "${requirement}", which is still on ` +
          `MongoDB. Every write would fail on a constraint violation.`,
      });
    }
  }

  for (const group of DATA_SOURCE_MOVE_TOGETHER) {
    const moved = group.modules.filter(onD1);
    if (moved.length === 0 || moved.length === group.modules.length) continue;
    for (const behind of group.modules.filter((name) => !onD1(name))) {
      for (const ahead of moved) {
        if (violations.some((v) => v.module === ahead && v.requires === behind)) continue;
        violations.push({
          module: ahead,
          requires: behind,
          message:
            `${envVarFor(ahead)}=d1 requires ${envVarFor(behind)}=d1: ${group.why}, so the ` +
            'two must move together.',
        });
      }
    }
  }

  return violations;
}

export class UnsafeDataSourceMatrixError extends Error {
  readonly violations: DataSourceViolation[];

  constructor(violations: DataSourceViolation[]) {
    super(
      `Unsafe DATA_SOURCE_* combination — refusing to start.\n\n` +
        violations.map((violation) => `  • ${violation.message}`).join('\n'),
    );
    this.name = 'UnsafeDataSourceMatrixError';
    this.violations = violations;
  }
}

/**
 * Fails closed on an unsafe split, at startup rather than on somebody's upload.
 *
 * Called from the environment validation path, which both runtimes run before serving. The
 * alternative — discovering the split when the first write hits a foreign key — means the
 * deployment looks healthy, `/api/health/ready` is green, and reads work; only writes fail, and
 * only for the module whose flag was wrong.
 */
export function assertDataSourceMatrix(): void {
  const violations = dataSourceViolations();
  if (violations.length > 0) throw new UnsafeDataSourceMatrixError(violations);
}

/**
 * The flags a Cloudflare Worker deployment must have on `d1`, which is all of them.
 *
 * A Worker cannot open the TCP socket Mongoose needs (`00-phase-0-analysis.md` §4), so any
 * module left on `mongo` there is not a slower path — it is a module that throws on first use.
 */
export function workerReadinessGaps(): DataSourceModule[] {
  // Configured, not routed — same reason as `dataSourceViolations`.
  return DATA_SOURCE_MODULES.filter((name) => configuredDataSourceFor(name) !== 'd1');
}
