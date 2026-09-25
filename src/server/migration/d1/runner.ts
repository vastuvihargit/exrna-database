/**
 * The migration engine: page, transform, batch, checkpoint, repeat.
 *
 * ── Where the safety comes from ─────────────────────────────────────────────────────────
 *
 * One page of source documents becomes one D1 `batch()`, which is one transaction. So a page
 * either lands complete — parent rows, child rows, FTS rows, all of it — or lands not at all,
 * and the checkpoint is only advanced after the batch returns. A crash therefore replays the
 * last page, and replaying is safe because every statement the steps emit is idempotent.
 *
 * ── Why failures do not stop the run ────────────────────────────────────────────────────
 *
 * A single unmigratable record must not end a load that is forty minutes in and holding a write
 * freeze open. So a record that throws is recorded in `d1_migration_failures` with its source id
 * and its payload, and the run continues. The report says how many, and the exit code is
 * non-zero, so nothing about it is quiet — but the decision of whether to proceed is a human's,
 * made with the whole picture rather than with the first bad row.
 *
 * A *batch* that fails is different: that is the database refusing, and it aborts the step.
 * Continuing past it would mean writing later pages on top of a gap.
 */
import { randomUUID } from 'node:crypto';
import type {
  DeltaFilter,
  D1Gateway,
  MigrationReport,
  MigrationStep,
  SourceDocument,
  Statement,
  StepContext,
  StepReport,
} from './types';
import { MIGRATION_STEPS } from './registry';
import { insert, upsert } from './sql';
import { oid } from './convert';

/** How many source documents are read, transformed and written as one transaction. */
export const DEFAULT_PAGE_SIZE = 250;

/** How many failures and skips the JSON report carries inline. The rest are in D1. */
export const FAILURE_SAMPLE_LIMIT = 50;

export interface RunOptions {
  gateway: D1Gateway;
  /** Restricts the run. Empty means every step, in registry order. */
  steps?: string[];
  delta: DeltaFilter;
  pageSize?: number;
  /** Reuse a previous run's id to resume from its checkpoints. */
  runId?: string;
  resume?: boolean;
  onProgress?: (message: string) => void;
}

interface Checkpoint {
  last_id: string | null;
  status: string;
  rows_read: number;
  rows_written: number;
  rows_skipped: number;
  rows_failed: number;
}

export async function runMigration(options: RunOptions): Promise<MigrationReport> {
  const runId = options.runId ?? `run_${new Date().toISOString().replace(/[^0-9]/g, '')}`;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const startedAt = new Date();
  const log = options.onProgress ?? (() => undefined);

  const selected = selectSteps(options.steps);
  const context: StepContext = { known: new Map(), now: startedAt.getTime() };
  const reports: StepReport[] = [];

  for (const step of selected) {
    const report = await runStep(step, { ...options, runId, pageSize }, context, log);
    reports.push(report);
    // A failed step stops the run. Every later step either depends on it — and would complete
    // with the missing rows recorded as orphans, then be skipped as "completed" on resume, so
    // the gap would never be filled — or does not, and gains nothing from running now rather
    // than after the resume. Stopping keeps "resume" meaning "carry on from exactly here".
    if (report.status === 'failed') {
      log(`Stopping: ${step.name} failed. Fix the cause and re-run with the same run id to resume.`);
      break;
    }
  }

  const finishedAt = new Date();
  const totals = reports.reduce(
    (accumulator, report) => ({
      read: accumulator.read + report.read,
      written: accumulator.written + report.written,
      skipped: accumulator.skipped + report.skipped,
      failed: accumulator.failed + report.failed,
    }),
    { read: 0, written: 0, skipped: 0, failed: 0 },
  );

  return {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    dryRun: options.gateway.dryRun,
    target: options.gateway.label,
    delta: options.delta.since ? options.delta.since.toISOString() : null,
    steps: reports,
    totals,
    // `skipped` is a success: it means the step already completed under this run id, which is
    // the normal state of every step before the crash point on a resumed run. Only `failed`
    // — the database refused — and a non-zero per-record failure count make a run not ok.
    ok: reports.every((report) => report.status !== 'failed') && totals.failed === 0,
  };
}

/**
 * Resolves `--steps` into an ordered, dependency-complete list.
 *
 * Selecting a step whose dependencies are not also selected is refused rather than reordered.
 * "Just run files" is a reasonable-sounding request and a foreign-key violation, and the useful
 * moment to say so is before anything is written.
 */
export function selectSteps(names?: string[]): MigrationStep[] {
  if (!names || names.length === 0) return [...MIGRATION_STEPS];

  const wanted = new Set(names);
  const unknown = names.filter((name) => !MIGRATION_STEPS.some((step) => step.name === name));
  if (unknown.length > 0) {
    throw new Error(`Unknown migration step(s): ${unknown.join(', ')}`);
  }

  const selected = MIGRATION_STEPS.filter((step) => wanted.has(step.name));
  for (const step of selected) {
    const missing = step.requires.filter((requirement) => !wanted.has(requirement));
    if (missing.length > 0) {
      throw new Error(
        `Step "${step.name}" requires ${missing.join(', ')}, which ${
          missing.length === 1 ? 'is' : 'are'
        } not in this run. ` +
          'Add them, or run every step. Running a dependent step alone fails on a foreign key ' +
          'part-way through a batch, which loses the whole batch.',
      );
    }
  }
  return selected;
}

async function runStep(
  step: MigrationStep,
  options: RunOptions & { runId: string; pageSize: number },
  context: StepContext,
  log: (message: string) => void,
): Promise<StepReport> {
  const { gateway, runId, pageSize, delta } = options;
  const startedAt = new Date();

  const published = step.publishes ? ensureSet(context.known, step.publishes) : null;
  const report: StepReport = {
    step: step.name,
    targets: [...step.targets],
    status: 'completed',
    sourceCount: 0,
    read: 0,
    written: 0,
    skipped: 0,
    failed: 0,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    failures: [],
    skips: [],
    lastError: null,
  };

  // What the target has durably accepted. Advanced only after a page's batch and its checkpoint
  // have both returned, so a failure records the last *committed* position and counts — not a
  // page that was read, counted and then refused. Recording the refused page would make a
  // resumed run count it twice; recording `null` would throw away every committed page.
  let committedCursor: string | null = null;
  let committed = countsOf(report);

  try {
    report.sourceCount = await step.count(delta);
    const checkpoint = options.resume ? await readCheckpoint(gateway, runId, step.name) : null;
    let cursor = checkpoint?.last_id ?? null;
    committedCursor = cursor;

    if (checkpoint?.status === 'completed') {
      log(`${step.name}: already completed in run ${runId}, skipping`);
      report.status = 'skipped';
      restoreCounts(report, checkpoint);
      // The published id set still has to be filled, or every later step would treat every
      // reference as dangling and skip its own records.
      if (published) await seedFromTarget(gateway, step.publishes as string, published);
      return finish(report, startedAt);
    }
    if (checkpoint) restoreCounts(report, checkpoint);
    committed = countsOf(report);

    // A resumed step needs the ids its own earlier pages wrote, and a delta run needs every id
    // the bulk load wrote: a delta pass reads only what changed, so without this a changed file
    // in an unchanged folder would look like an orphan — skipped, or rewritten with its
    // references set to NULL. The ids come from the *target*, not the source, because every
    // reference check is asking "will this foreign key resolve in D1?", and a source record the
    // bulk load skipped is exactly the one that would not.
    if (published && (cursor || delta.since)) {
      await seedFromTarget(gateway, step.publishes as string, published);
    }

    await writeCheckpoint(gateway, runId, step, {
      status: 'running',
      dryRun: gateway.dryRun,
      lastId: cursor,
      startedAt: startedAt.toISOString(),
      report,
    });

    for (;;) {
      const documents = await step.read(cursor, pageSize, delta);
      if (documents.length === 0) break;

      const statements: Statement[] = [];
      const failures: { sourceId: string; reason: string; payload: string }[] = [];

      for (const document of documents) {
        const sourceId = oid(document._id) ?? '(no id)';
        report.read += 1;
        try {
          const outcome = step.transform(document, context);
          if (outcome.kind === 'skip') {
            report.skipped += 1;
            if (report.skips.length < FAILURE_SAMPLE_LIMIT) {
              report.skips.push({ sourceId, reason: outcome.reason });
            }
            continue;
          }
          statements.push(...outcome.statements);
          report.written += 1;
          // Published *after* a successful transform and before the batch: a later step in the
          // same page cannot reference this row anyway, and a failed batch aborts the step.
          if (published) published.add(sourceId);
        } catch (error) {
          report.failed += 1;
          const reason = error instanceof Error ? error.message : String(error);
          failures.push({ sourceId, reason, payload: safePayload(document) });
          if (report.failures.length < FAILURE_SAMPLE_LIMIT) {
            report.failures.push({ sourceId, reason });
          }
        }
      }

      // One page, one transaction. The failure rows go in the same call, so a report of what
      // could not be migrated cannot outlive a rollback of the page it describes.
      await gateway.run([
        ...statements,
        ...failures.map((failure) =>
          insert('d1_migration_failures', {
            id: randomUUID(),
            run_id: runId,
            collection: step.name,
            source_id: failure.sourceId,
            reason: failure.reason.slice(0, 500),
            payload: failure.payload,
            created_at: new Date().toISOString(),
          }),
        ),
      ]);

      cursor = lastId(documents);
      await writeCheckpoint(gateway, runId, step, {
        status: 'running',
        dryRun: gateway.dryRun,
        lastId: cursor,
        startedAt: startedAt.toISOString(),
        report,
      });
      committedCursor = cursor;
      committed = countsOf(report);

      log(
        `${step.name}: ${report.read}/${report.sourceCount} read, ` +
          `${report.written} written, ${report.skipped} skipped, ${report.failed} failed`,
      );

      if (documents.length < pageSize) break;
    }

    await writeCheckpoint(gateway, runId, step, {
      status: 'completed',
      dryRun: gateway.dryRun,
      lastId: cursor,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      report,
    });
  } catch (error) {
    report.status = 'failed';
    report.lastError = error instanceof Error ? error.message : String(error);
    restoreCounts(report, committed);
    log(`${step.name}: FAILED — ${report.lastError}`);
    await writeCheckpoint(gateway, runId, step, {
      status: 'failed',
      dryRun: gateway.dryRun,
      lastId: committedCursor,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      lastError: report.lastError,
      report,
    }).catch(() => undefined);
  }

  return finish(report, startedAt);
}

function finish(report: StepReport, startedAt: Date): StepReport {
  const finishedAt = new Date();
  report.finishedAt = finishedAt.toISOString();
  report.durationMs = finishedAt.getTime() - startedAt.getTime();
  return report;
}

/**
 * The resume cursor for a page.
 *
 * The page is known to be non-empty at every call site, but the check is real rather than an
 * assertion: a cursor that silently became null would restart the step from the beginning on
 * the next iteration, and the symptom is a migration that never terminates.
 */
function lastId(documents: SourceDocument[]): string | null {
  const last = documents[documents.length - 1];
  return last ? oid(last._id) : null;
}

function ensureSet(known: Map<string, Set<string>>, key: string): Set<string> {
  const existing = known.get(key);
  if (existing) return existing;
  const created = new Set<string>();
  known.set(key, created);
  return created;
}

interface CommittedCounts {
  rows_read: number;
  rows_written: number;
  rows_skipped: number;
  rows_failed: number;
}

function countsOf(report: StepReport): CommittedCounts {
  return {
    rows_read: report.read,
    rows_written: report.written,
    rows_skipped: report.skipped,
    rows_failed: report.failed,
  };
}

function restoreCounts(report: StepReport, counts: CommittedCounts): void {
  report.read = counts.rows_read;
  report.written = counts.rows_written;
  report.skipped = counts.rows_skipped;
  report.failed = counts.rows_failed;
}

/** A published name is interpolated into a query, so it is checked rather than trusted. */
const TABLE_NAME = /^[a-z_]+$/;
const SEED_PAGE_SIZE = 5000;

/**
 * Fills a reference set with the ids the target already holds.
 *
 * Needed whenever a step is skipped, resumed or run as a delta: the reference checks in every
 * later step are driven by these sets, and an empty set makes every later record look like an
 * orphan. Paged by primary key, because a whole large table in one `wrangler d1 execute --json`
 * response is a real limit rather than a theoretical one. Against an `OfflineGateway` it reads
 * nothing, which is correct: an offline dry run has no target for anything to reference.
 */
async function seedFromTarget(
  gateway: D1Gateway,
  table: string,
  target: Set<string>,
): Promise<void> {
  if (!TABLE_NAME.test(table)) throw new Error(`Refusing to read ids from "${table}"`);
  let cursor = '';
  for (;;) {
    const rows = await gateway.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`,
      [cursor, SEED_PAGE_SIZE],
    );
    for (const row of rows) target.add(row.id);
    const last = rows[rows.length - 1];
    if (!last || rows.length < SEED_PAGE_SIZE) break;
    cursor = last.id;
  }
}

/**
 * The payload kept with a failure.
 *
 * Truncated, because a failure report is read by a human and a 200 KB document is not read by
 * anybody. Kept at all because the alternative — re-deriving the offending document from its id
 * days later — assumes MongoDB is still there, which after a cutover it may not be.
 */
function safePayload(document: SourceDocument): string {
  try {
    return JSON.stringify(document).slice(0, 4000);
  } catch {
    return '(payload could not be serialised)';
  }
}

async function readCheckpoint(
  gateway: D1Gateway,
  runId: string,
  step: string,
): Promise<Checkpoint | null> {
  const rows = await gateway.query<Checkpoint>(
    'SELECT last_id, status, rows_read, rows_written, rows_skipped, rows_failed ' +
      'FROM d1_migration_runs WHERE run_id = ? AND collection = ?',
    [runId, step],
  );
  return rows[0] ?? null;
}

async function writeCheckpoint(
  gateway: D1Gateway,
  runId: string,
  step: MigrationStep,
  state: {
    status: string;
    dryRun: boolean;
    lastId: string | null;
    startedAt: string;
    finishedAt?: string;
    lastError?: string;
    report: StepReport;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await gateway.run([
    upsert(
      'd1_migration_runs',
      {
        // Deterministic, so a resumed run updates its own row instead of adding a second one
        // and making "how far did it get?" ambiguous.
        id: `${runId}:${step.name}`,
        run_id: runId,
        collection: step.name,
        status: state.status,
        dry_run: state.dryRun ? 1 : 0,
        last_id: state.lastId,
        rows_read: state.report.read,
        rows_written: state.report.written,
        rows_skipped: state.report.skipped,
        rows_failed: state.report.failed,
        source_count: state.report.sourceCount,
        target_count: null,
        started_at: state.startedAt,
        finished_at: state.finishedAt ?? null,
        last_error: state.lastError ?? null,
        created_at: now,
        updated_at: now,
      },
      ['id'],
    ),
  ]);
}
