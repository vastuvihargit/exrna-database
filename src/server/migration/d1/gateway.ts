/**
 * The three ways the migration can reach a D1 database.
 *
 *   binding  — a real `D1Database`. What the tests use (through Miniflare) and what a Worker or
 *              a Workflow would use. Statements go through the actual binding API, so `batch()`
 *              atomicity and the 100-parameter ceiling behave exactly as they will in production.
 *   wrangler — shells out to `wrangler d1 execute`. The production path from an operator's
 *              laptop or a CI job, and the only one that can reach a *remote* D1 from Node.
 *   dry run  — wraps either of the above, reads through it and discards every write.
 *
 * The step code cannot tell them apart. That is what makes a rehearsal worth something: the
 * rehearsal and the cutover run the same transforms, the same statements and the same
 * verification, and differ only in which of these three objects they were handed.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { D1Database } from '@cloudflare/workers-types';
import type { D1Gateway, SqlValue, Statement } from './types';

/* ------------------------------------------------------------------ binding */

export class BindingGateway implements D1Gateway {
  readonly dryRun = false;

  constructor(
    private readonly db: D1Database,
    readonly label = 'binding',
  ) {}

  async run(statements: Statement[]): Promise<void> {
    if (statements.length === 0) return;
    const prepared = statements.map((statement) =>
      this.db.prepare(statement.sql).bind(...statement.params),
    );
    // `batch` is one implicit transaction: all of these commit or none do. A step's statements
    // are handed over together precisely so a mid-record failure cannot leave a parent row
    // without its children.
    await this.db.batch(prepared as never);
  }

  async query<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const result = await this.db
      .prepare(sql)
      .bind(...params)
      .all<T>();
    return (result.results ?? []) as T[];
  }
}

/* ------------------------------------------------------------------ wrangler */

/**
 * Renders a bound parameter as a SQL literal.
 *
 * `wrangler d1 execute --file` has no parameter binding, so the file sink has to inline. This
 * is the one place in the codebase where a value becomes part of a SQL string, and it is
 * written to be boring: single quotes doubled, everything else passed through, and anything it
 * cannot represent refused rather than mangled.
 *
 * The refusal matters. A NUL byte silently truncates the statement at the point it appears in
 * some SQLite drivers, which would write a *shorter, still valid* row — a corruption that looks
 * like a successful migration.
 */
export function literal(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot render ${value} as a SQL literal`);
    }
    return String(value);
  }
  if (value.includes('\u0000')) {
    throw new Error('Value contains a NUL byte and cannot be written through a .sql file');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export function renderStatement(statement: Statement): string {
  let index = 0;
  // Replaces each `?` in order. The builders in `sql.ts` never emit a literal `?` inside a
  // string, and every statement they produce is generated rather than hand-written, so a
  // positional walk is exact rather than a heuristic.
  const rendered = statement.sql.replace(/\?/g, () => {
    if (index >= statement.params.length) {
      throw new Error(`Statement has more placeholders than parameters: ${statement.sql}`);
    }
    const parameter = statement.params[index];
    index += 1;
    return literal(parameter as SqlValue);
  });
  if (index !== statement.params.length) {
    throw new Error(`Statement has ${statement.params.length} parameters and ${index} placeholders`);
  }
  return `${rendered};`;
}

export interface WranglerGatewayOptions {
  /** The `database_name` from `wrangler.jsonc`, e.g. `biotech-drive-production`. */
  database: string;
  /** `development` | `staging` | `production`. */
  env: string;
  /** `--remote` against the real database, `--local` against the wrangler state directory. */
  remote: boolean;
  /** Where the generated `.sql` files are written. Kept after the run, as the audit trail. */
  workDir: string;
  /**
   * Writes one batch file and returns its path.
   *
   * Injected rather than imported, because `src/server/**` does not touch the filesystem —
   * the eslint boundary says only the storage layer does, and it is right: a module that can
   * write to disk is a module that cannot run in a Worker. `scripts/migrate-to-d1.ts` supplies
   * the implementation, and a test supplies one that keeps the bytes in memory, which is how
   * the rendered SQL gets asserted without a temporary directory.
   */
  writeSql: (filePath: string, contents: string) => Promise<void>;
  /** Overridable so tests can point at a stub instead of spawning wrangler. */
  exec?: (args: string[]) => Promise<string>;
}

export class WranglerGateway implements D1Gateway {
  readonly dryRun = false;
  readonly label: string;

  private fileCounter = 0;

  constructor(private readonly options: WranglerGatewayOptions) {
    this.label = `${options.database} (${options.remote ? 'remote' : 'local'})`;
  }

  private exec(args: string[]): Promise<string> {
    if (this.options.exec) return this.options.exec(args);
    return runWrangler(args);
  }

  private baseArgs(): string[] {
    return [
      'd1',
      'execute',
      this.options.database,
      '--env',
      this.options.env,
      this.options.remote ? '--remote' : '--local',
    ];
  }

  /**
   * Applies a batch by writing a file and executing it.
   *
   * `--file` rather than a `--command` per statement for a reason that shows up at scale: a
   * wrangler process spawn is ~1 s, so a corpus of 50 000 records would spend fourteen hours in
   * process startup. One file per batch turns that into one spawn per 500 records.
   *
   * The files are **kept**. They are the exact bytes applied to production, which is the
   * artefact an incident review asks for and which cannot be reconstructed afterwards.
   */
  async run(statements: Statement[]): Promise<void> {
    if (statements.length === 0) return;

    this.fileCounter += 1;
    const file = path.join(
      this.options.workDir,
      `batch-${String(this.fileCounter).padStart(6, '0')}.sql`,
    );
    await this.options.writeSql(file, `${statements.map(renderStatement).join('\n')}\n`);

    await this.exec([...this.baseArgs(), '--file', file]);
  }

  async query<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const rendered = renderStatement({ sql, params });
    const output = await this.exec([...this.baseArgs(), '--json', '--command', rendered]);
    return parseWranglerJson<T>(output);
  }
}

/**
 * `wrangler d1 execute --json` prints an array of result objects, one per statement — but it
 * also prints banner lines on some versions, so the JSON is located rather than assumed to
 * start at byte zero.
 */
export function parseWranglerJson<T>(output: string): T[] {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];

  const parsed = JSON.parse(output.slice(start, end + 1)) as { results?: T[] }[];
  return parsed.flatMap((entry) => entry.results ?? []);
}

function runWrangler(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // `npx` rather than a bare `wrangler`: the dependency is local, and an operator running the
    // cutover should not have to have installed it globally at the right version.
    const child = spawn('npx', ['--yes', 'wrangler', ...args], {
      shell: process.platform === 'win32',
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`wrangler ${args.join(' ')} exited ${code}\n${stderr || stdout}`));
    });
  });
}

/* ------------------------------------------------------------------ dry run */

/**
 * Reads through, writes nowhere.
 *
 * Wrapping a real gateway rather than being a null object, because a dry run that cannot read
 * the target is not a rehearsal of anything: the checkpoint store, the reference checks and the
 * count comparison all need the real database. What it must not do is change it, and there is
 * exactly one method it has to intercept to guarantee that.
 *
 * `statementsSeen` is kept so the dry run can report *what it would have written*, which is the
 * question a reviewer actually has.
 */
export class DryRunGateway implements D1Gateway {
  readonly dryRun = true;
  readonly label: string;

  statementsSeen = 0;
  readonly sample: string[] = [];

  constructor(
    private readonly inner: D1Gateway,
    private readonly sampleLimit = 25,
  ) {
    this.label = `${inner.label} [dry run]`;
  }

  async run(statements: Statement[]): Promise<void> {
    for (const statement of statements) {
      this.statementsSeen += 1;
      // Rendering every statement is the cheapest possible validation of the whole pipeline: it
      // proves the placeholders and parameters agree and that no value is unrepresentable,
      // which is most of what goes wrong between a transform and a database.
      const rendered = renderStatement(statement);
      if (this.sample.length < this.sampleLimit) this.sample.push(rendered);
    }
  }

  query<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    assertReadOnly(sql);
    return this.inner.query<T>(sql, params);
  }
}

/**
 * Refuses anything but a read.
 *
 * `query` is the one path through a dry run that reaches the real database, so "a dry run
 * writes nothing" would otherwise rest on every caller only ever passing SELECTs. Enforced
 * here instead, so the guarantee is a property of the gateway rather than of its callers.
 */
export function assertReadOnly(sql: string): void {
  const statement = sql.trim();
  if (!/^(SELECT|WITH|EXPLAIN)\b/i.test(statement) || /;\s*\S/.test(statement)) {
    throw new Error(`Refusing a non-read statement on a read-only gateway: ${statement.slice(0, 80)}`);
  }
  // A CTE can carry a write (`WITH x AS (…) DELETE …`), so a WITH is checked for one.
  if (/^WITH\b/i.test(statement) && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statement)) {
    throw new Error(`Refusing a write inside a CTE on a read-only gateway: ${statement.slice(0, 80)}`);
  }
}

/**
 * Reads through, refuses every write.
 *
 * What the verifier runs against. Verification is documented as read-only on both databases,
 * and this makes that true by construction rather than by review.
 */
export class ReadOnlyGateway implements D1Gateway {
  readonly dryRun = true;
  readonly label: string;

  constructor(private readonly inner: D1Gateway) {
    this.label = `${inner.label} [read-only]`;
  }

  async run(statements: Statement[]): Promise<void> {
    if (statements.length > 0) {
      throw new Error('Refusing to write through a read-only gateway');
    }
  }

  query<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    assertReadOnly(sql);
    return this.inner.query<T>(sql, params);
  }
}

/** A gateway with no target at all, for a dry run against a database that does not exist yet. */
export class OfflineGateway implements D1Gateway {
  readonly dryRun = true;
  readonly label = 'offline';

  async run(): Promise<void> {
    return undefined;
  }

  async query<T = Record<string, unknown>>(): Promise<T[]> {
    return [] as T[];
  }
}

export function defaultWorkDir(runId: string): string {
  return path.join(os.tmpdir(), 'biotech-drive-migration', runId);
}
