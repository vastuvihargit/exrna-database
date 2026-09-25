/**
 * Statement builders for the migration.
 *
 * Deliberately not drizzle. The loader has to emit the *same* statements to three very
 * different places — a D1 binding, a `.sql` file for `wrangler d1 execute`, and a dry run that
 * only counts them — and the common denominator of all three is `{ sql, params }`. Going
 * through the query builder would mean either a second code path for the file sink or building
 * SQL from a drizzle statement's internals, which is a private API.
 *
 * Column names are written out in the step files rather than imported from the drizzle schema.
 * That is a deliberate cost: it means a schema rename does not silently change what the
 * migration writes, and `tests/d1/migration-schema-contract.test.ts` compares the two lists so
 * the divergence is caught by a test rather than by a cutover.
 */
import type { SqlValue, Statement } from './types';

/**
 * D1 binds at most 100 parameters per statement — measured, not assumed; see
 * `tests/d1/bound-parameter-limit.test.ts` and FINAL-READINESS §5.1.
 *
 * Every table here is comfortably inside it (`file_versions` is the widest at 48 columns), so
 * this is a tripwire for a future column addition rather than a limit anything approaches.
 */
export const MAX_BOUND_PARAMS = 100;

function guard(statement: Statement): Statement {
  if (statement.params.length > MAX_BOUND_PARAMS) {
    throw new Error(
      `Statement binds ${statement.params.length} parameters; D1 accepts ${MAX_BOUND_PARAMS}. ` +
        `Split the write: ${statement.sql.slice(0, 120)}…`,
    );
  }
  return statement;
}

export type Row = Record<string, SqlValue>;

/**
 * Insert, or update the existing row in place.
 *
 * **Upsert rather than `INSERT OR REPLACE`, and the difference is load-bearing.** REPLACE is a
 * DELETE followed by an INSERT, so on `files` it would cascade into `file_metadata` and
 * `file_folder_ancestors` and delete the child rows a previous step wrote — a delta pass that
 * re-ran `files` alone would quietly empty the metadata of every file it touched. It would also
 * fire the FTS delete/insert trigger pair, which rebuilds the index row with *empty* keywords,
 * because the insert trigger does not aggregate children.
 *
 * `DO UPDATE` leaves children alone and fires `trg_files_fts_update`, which re-reads tags and
 * metadata. So the idempotent path is also the one that keeps search correct.
 */
export function upsert(table: string, row: Row, conflict: string[] = ['id']): Statement {
  const columns = Object.keys(row);
  const assignments = columns
    .filter((column) => !conflict.includes(column))
    .map((column) => `${column} = excluded.${column}`);

  const sql =
    `INSERT INTO ${table} (${columns.join(', ')}) ` +
    `VALUES (${columns.map(() => '?').join(', ')}) ` +
    (assignments.length > 0
      ? `ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET ${assignments.join(', ')}`
      : `ON CONFLICT (${conflict.join(', ')}) DO NOTHING`);

  return guard({ sql, params: columns.map((column) => row[column] as SqlValue) });
}

/**
 * Insert, or leave the existing row exactly as it is.
 *
 * For the two append-only tables — `audit_logs` and `stock_transactions` — where migration 0001
 * installs `RAISE(ABORT)` triggers on UPDATE and DELETE. `upsert()` is the wrong shape there and
 * not merely redundant: its `DO UPDATE` branch fires on the *second* run, so a resumed run
 * replaying its last page, or a delta pass, would abort the whole batch on a trigger. The first
 * run would look fine and the failure would surface during the cutover.
 *
 * `DO NOTHING` is also the semantically correct answer. An audit row and a stock movement are
 * statements about something that already happened; there is no later version of them to write.
 */
export function insertImmutable(table: string, row: Row, conflict: string[] = ['id']): Statement {
  const columns = Object.keys(row);
  return guard({
    sql:
      `INSERT INTO ${table} (${columns.join(', ')}) ` +
      `VALUES (${columns.map(() => '?').join(', ')}) ` +
      `ON CONFLICT (${conflict.join(', ')}) DO NOTHING`,
    params: columns.map((column) => row[column] as SqlValue),
  });
}

/**
 * Plain insert for a table with no primary key — the join tables.
 *
 * Always paired with `deleteWhere` on the same parent in the same batch, which is what makes
 * the pair idempotent: a re-run replaces the parent's whole child set, so an element removed in
 * MongoDB disappears from D1 instead of lingering.
 */
export function insert(table: string, row: Row): Statement {
  const columns = Object.keys(row);
  return guard({
    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    params: columns.map((column) => row[column] as SqlValue),
  });
}

export function deleteWhere(table: string, where: Row): Statement {
  const columns = Object.keys(where);
  return guard({
    sql: `DELETE FROM ${table} WHERE ${columns.map((column) => `${column} = ?`).join(' AND ')}`,
    params: columns.map((column) => where[column] as SqlValue),
  });
}

export function update(table: string, set: Row, where: Row): Statement {
  const setColumns = Object.keys(set);
  const whereColumns = Object.keys(where);
  return guard({
    sql:
      `UPDATE ${table} SET ${setColumns.map((column) => `${column} = ?`).join(', ')} ` +
      `WHERE ${whereColumns.map((column) => `${column} = ?`).join(' AND ')}`,
    params: [
      ...setColumns.map((column) => set[column] as SqlValue),
      ...whereColumns.map((column) => where[column] as SqlValue),
    ],
  });
}

/**
 * Rewrites one file's `files_fts` row, reproducing `trg_files_fts_update` exactly.
 *
 * The migration cannot rely on the triggers alone. `trg_files_fts_insert` writes empty
 * `keywords` and `description` — by design, because at INSERT time the tags and metadata rows
 * do not exist yet — and nothing re-aggregates them afterwards unless the `files` row is updated
 * again. A migrated corpus would therefore be searchable by filename and by nothing else, and
 * the symptom is a search that returns fewer results than it should, which nobody notices.
 *
 * DELETE-then-INSERT because `files_fts` is a standalone FTS5 table with no unique constraint on
 * `file_id`: an INSERT alone accumulates a row per write and every search returns the file once
 * per stale copy. The pair is idempotent, so it is safe to run after a trigger has already
 * rebuilt the row. `file.repository.d1.ts` uses the same shape for the same reason.
 */
export function refreshFileFts(
  fileId: string,
  content: { displayName: string; originalFilename: string; keywords: string; description: string } | null,
): Statement[] {
  const statements: Statement[] = [
    { sql: 'DELETE FROM files_fts WHERE file_id = ?', params: [fileId] },
  ];
  if (content) {
    statements.push({
      sql:
        'INSERT INTO files_fts (file_id, display_name, original_filename, keywords, description) ' +
        'VALUES (?, ?, ?, ?, ?)',
      params: [
        fileId,
        content.displayName,
        content.originalFilename,
        content.keywords,
        content.description,
      ],
    });
  }
  return statements;
}

/** The same for `experiments_fts`, whose `samples` column aggregates `experiment_samples`. */
export function refreshExperimentFts(
  experimentId: string,
  content: { code: string; title: string; samples: string; objective: string } | null,
): Statement[] {
  const statements: Statement[] = [
    { sql: 'DELETE FROM experiments_fts WHERE experiment_id = ?', params: [experimentId] },
  ];
  if (content) {
    statements.push({
      sql:
        'INSERT INTO experiments_fts (experiment_id, code, title, samples, objective) ' +
        'VALUES (?, ?, ?, ?, ?)',
      params: [experimentId, content.code, content.title, content.samples, content.objective],
    });
  }
  return statements;
}

/**
 * The keyword and description projection `trg_files_fts_update` builds.
 *
 * Including the separator space the trigger emits even when one side is empty — the two must
 * produce identical text, or a file's search behaviour would depend on which path last wrote it.
 */
export function fileFtsContent(
  displayName: string,
  originalFilename: string,
  tags: string[],
  metadata: Record<string, unknown>,
): { displayName: string; originalFilename: string; keywords: string; description: string } {
  const keywordMetadata = ['sampleId', 'experimentCode']
    .map((key) => metadata[key])
    .filter((value) => value !== undefined && value !== null)
    .map(String);

  return {
    displayName,
    originalFilename,
    keywords: `${tags.join(' ')} ${keywordMetadata.join(' ')}`,
    description: metadata.description === undefined ? '' : String(metadata.description),
  };
}
