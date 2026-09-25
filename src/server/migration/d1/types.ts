/**
 * The MongoDB → D1 metadata migration, stated as data.
 *
 * ── Why a step list rather than a script ────────────────────────────────────────────────
 *
 * A cutover is rehearsed many times and performed once, and the thing that makes rehearsal
 * worth anything is that the rehearsal and the performance run the *same* code. So the
 * migration is a list of steps, each of which knows how to read a slice of MongoDB, turn it
 * into SQL statements, and report what it did — and the difference between a dry run, a
 * rehearsal against a local database and the real thing is which gateway the steps are handed.
 *
 * ── Every step is idempotent, and that is not a nicety ──────────────────────────────────
 *
 * A migration that cannot be re-run is a migration that has to succeed first time, during a
 * write freeze, with people waiting. Every step here writes with an `ON CONFLICT` upsert keyed on
 * the primary key, and every step that expands a MongoDB array into child rows deletes that
 * parent's children before re-inserting them. Re-running converges; it never duplicates. That
 * is also what makes the **final delta pass** — re-run everything changed since the bulk load —
 * a re-run of the same steps rather than a second, less-tested code path.
 *
 * ── Identity is preserved, so verification is a comparison and not a mapping ────────────
 *
 * Every `_id` becomes the same 24-character hex string in D1's TEXT primary key. No mapping
 * table exists, because none is needed: a count, a spot check and a relationship check all
 * compare ids directly between the two databases. `schema/_shared.ts` states the same rule from
 * the other side.
 */

/** What D1 accepts as a bound parameter. `boolean` is deliberately absent — SQLite has none. */
export type SqlValue = string | number | null;

/** One statement, parameterised. Never string-interpolated: see `literal()` in `gateway.ts`. */
export interface Statement {
  sql: string;
  params: SqlValue[];
}

/**
 * The database, from the migration's point of view.
 *
 * Three implementations: a Worker/Miniflare binding (tests and the Workflow), `wrangler d1
 * execute` (the production path, local or remote), and a dry-run wrapper that reads through and
 * discards writes. The step code cannot tell them apart, which is the point.
 */
export interface D1Gateway {
  /** Applies statements. Implementations must apply them in order and atomically per call. */
  run(statements: Statement[]): Promise<void>;
  /** Reads. Used by the checkpoint store and by every verification query. */
  query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** True when writes are discarded. Reported, so a green dry run is never mistaken for a load. */
  readonly dryRun: boolean;
  /** For the report: which database this ran against. */
  readonly label: string;
}

/** A source document, already `.lean()`ed. Mongo types (ObjectId, Date) are still present. */
export type SourceDocument = Record<string, unknown>;

/**
 * One record's translation.
 *
 * `skip` is not an error: a notification whose user no longer exists, or a star pointing at a
 * purged file, is a legitimately unmigratable row and the report says so with a reason. A
 * *failure* is a record that should have migrated and did not.
 */
export type StepOutcome =
  | { kind: 'write'; statements: Statement[] }
  | { kind: 'skip'; reason: string };

export interface StepContext {
  /**
   * Ids known to exist in the target, per table, populated as earlier steps run.
   *
   * This is what turns a foreign-key violation — which in D1 aborts the whole batch and takes
   * 499 good records with it — into a per-record `skip` with a reason. It is populated only for
   * the tables later steps actually check against.
   */
  known: Map<string, Set<string>>;
  /** `Date.now()` at the start of the run, so ACL expiry resolution is stable across steps. */
  now: number;
}

/**
 * A migration step: one MongoDB read shape, one target table (or table group).
 *
 * Steps are also the unit of checkpointing — `d1_migration_runs` holds one row per step per run
 * — so "resume" means "re-read this step from its last id", and nothing more clever.
 */
export interface MigrationStep {
  /** Stable identifier. Appears in `d1_migration_runs.collection` and in `--steps`. */
  readonly name: string;
  /** Human-facing, for the console. */
  readonly description: string;
  /** The D1 tables this step writes. Used by the count comparison and by `--only-tables`. */
  readonly targets: readonly string[];
  /**
   * Steps that must have completed first.
   *
   * Declared rather than inferred from array order so a partial run (`--steps files`) can refuse
   * to run something whose parents are absent instead of failing on a foreign key mid-batch.
   */
  readonly requires: readonly string[];
  /**
   * Ids this step should record in `StepContext.known`, so later steps can check references.
   * The key is the table name; the value is read from the produced primary keys.
   */
  readonly publishes?: string;

  /** Number of source documents, for the progress line and the count comparison. */
  count(filter: DeltaFilter): Promise<number>;

  /**
   * Reads the next page of source documents.
   *
   * `afterId` is the resume cursor. ObjectId hex sorts monotonically by creation time, so
   * `_id > afterId` ordered by `_id` is stable across restarts and needs no offset.
   */
  read(afterId: string | null, limit: number, filter: DeltaFilter): Promise<SourceDocument[]>;

  /** Translates one document. Throwing is a failure; returning `skip` is a recorded decision. */
  transform(document: SourceDocument, context: StepContext): StepOutcome;
}

/**
 * Restricts a run to documents changed since a moment — the final delta pass.
 *
 * `null` means everything. When set, steps filter on `updatedAt` where the collection has one
 * and on `createdAt` where it does not (append-only collections: audit, activities, approvals,
 * stock transactions). A collection with neither migrates in full, because "changed since" is
 * unanswerable and a silent partial delta is the worst outcome available.
 */
export interface DeltaFilter {
  since: Date | null;
}

export const NO_DELTA: DeltaFilter = { since: null };

/* ------------------------------------------------------------------ reporting */

export interface StepReport {
  step: string;
  targets: string[];
  status: 'completed' | 'failed' | 'skipped';
  sourceCount: number;
  read: number;
  written: number;
  skipped: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Up to `FAILURE_SAMPLE_LIMIT`; the full set is in `d1_migration_failures`. */
  failures: { sourceId: string; reason: string }[];
  skips: { sourceId: string; reason: string }[];
  lastError: string | null;
}

export interface MigrationReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
  target: string;
  delta: string | null;
  steps: StepReport[];
  totals: { read: number; written: number; skipped: number; failed: number };
  /** False if any step failed, so a machine can gate on one field. */
  ok: boolean;
}
