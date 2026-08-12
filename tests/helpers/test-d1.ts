/**
 * In-process D1 harness for the Phase 3 repository suites.
 *
 * ── Why Miniflare rather than `wrangler d1 execute` ─────────────────────────────────────
 *
 * `tests/d1/schema-contract.test.ts` shells out to wrangler, which is right for that suite:
 * it asserts what the *deployed* engine does with a handful of statements, and 10 s per
 * assertion is an acceptable price for 12 assertions.
 *
 * A repository suite makes hundreds of calls. At a process spawn each it would take an hour,
 * and a suite that takes an hour is a suite people stop running. Miniflare embeds the same
 * workerd SQLite that `wrangler dev --local` uses and hands back a real `D1Database` object,
 * so the calls go through the actual D1 binding API — prepared statements, `batch()`,
 * `RETURNING` and all — without a process boundary.
 *
 * ── Both migrations are applied ─────────────────────────────────────────────────────────
 *
 * Module 1 (users, departments) needed only 0000. Module 2 needs 0001 as well, because
 * `role_permissions.permission_key` carries a foreign key to the `permissions` catalogue and
 * that catalogue is seeded by 0001. A repository suite running against a database missing a
 * constraint the deployment has is a suite that cannot fail the way production would.
 *
 * The two files need different splitters — see `splitStatements`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { D1Database } from '@cloudflare/workers-types';
import type { Miniflare } from 'miniflare';

const MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle', 'migrations');

let instance: Miniflare | null = null;

/**
 * Splits a migration file into statements.
 *
 * drizzle-kit emits an explicit `--> statement-breakpoint` marker, precisely because splitting
 * generated SQL on `;` is wrong the moment a statement contains one. Migration 0001 is
 * hand-written and has no markers, so it is split on `;` — with the one rule that makes that
 * safe here: a `CREATE TRIGGER` body runs from `BEGIN` to `END;` and every semicolon inside it
 * belongs to the trigger, not to the file. Splitting naively would cut all four immutability
 * triggers in half and apply the fragments.
 */
export function splitStatements(sql: string): string[] {
  if (sql.includes('--> statement-breakpoint')) {
    return sql
      .split('--> statement-breakpoint')
      .map(stripCommentLines)
      .filter((statement) => statement.length > 0);
  }

  const statements: string[] = [];
  let current = '';
  let insideTriggerBody = false;

  for (const rawLine of sql.split('\n')) {
    const line = stripComment(rawLine);
    if (!line.trim() && !current.trim()) continue;

    current += `${line}\n`;

    if (!insideTriggerBody && /\bCREATE\s+TRIGGER\b/i.test(current) && /\bBEGIN\b/i.test(current)) {
      insideTriggerBody = true;
    }

    if (insideTriggerBody) {
      if (/\bEND\s*;/i.test(line)) {
        statements.push(current.trim());
        current = '';
        insideTriggerBody = false;
      }
      continue;
    }

    if (line.trim().endsWith(';')) {
      statements.push(current.trim());
      current = '';
    }
  }

  if (current.trim()) statements.push(current.trim());
  return statements.filter((statement) => statement.replace(/;$/, '').trim().length > 0);
}

/**
 * Strips comments from every line of a chunk.
 *
 * Line by line, not chunk by chunk: `stripComment` truncates at the first `--`, so applying it
 * to a whole chunk deletes everything after a leading header comment. That silently dropped the
 * `DROP INDEX` from migration 0002 and the run failed on the following `CREATE` instead — the
 * kind of bug that looks like the migration is wrong when the harness is.
 */
function stripCommentLines(chunk: string): string {
  return chunk
    .split('\n')
    .map(stripComment)
    .join('\n')
    .trim();
}

/**
 * Strips a `--` line comment, but not a `--` that falls inside a string literal — the permission
 * catalogue seeds description text, and truncating a row's description at an em-dash would
 * produce a statement that still parses and inserts the wrong value.
 */
function stripComment(line: string): string {
  let insideString = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "'") insideString = !insideString;
    if (!insideString && char === '-' && line[i + 1] === '-') return line.slice(0, i);
  }
  return line;
}

export async function startTestD1(): Promise<D1Database> {
  const { Miniflare } = await import('miniflare');

  instance = new Miniflare({
    modules: true,
    // Miniflare needs a Worker to host the bindings; nothing ever fetches this one.
    script: 'export default { fetch: () => new Response("test-harness") };',
    d1Databases: { DB: 'phase3-repository-tests' },
  });

  const database = (await instance.getD1Database('DB')) as unknown as D1Database;

  // Read from the directory rather than a hand-maintained list. The list was a standing
  // trap: adding a migration and forgetting to name it here produces a suite that runs
  // against the *previous* schema and reports the same green ticks as one that did not.
  const names = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (names.length === 0) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  }

  for (const name of names) {
    const file = path.join(MIGRATIONS_DIR, name);
    const statements = splitStatements(fs.readFileSync(file, 'utf8'));

    // Fails loudly rather than skipping. A repository suite that ran against a database with
    // no tables would report the same green ticks as one that verified something.
    if (statements.length === 0) {
      throw new Error(`No statements parsed from ${file} — the migration format has changed.`);
    }

    for (const statement of statements) {
      try {
        await database.prepare(statement).run();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${name} failed on:\n${statement.slice(0, 300)}\n\n${detail}`);
      }
    }
  }

  return database;
}

export async function stopTestD1(): Promise<void> {
  if (instance) {
    await instance.dispose();
    instance = null;
  }
}

/**
 * Runs a caller-supplied list of reset statements in order.
 *
 * Takes statements rather than table names on purpose. `users` and `departments` reference
 * each other — `users.department_id` → `departments.id` and `departments.created_by` →
 * `users.id` — so no delete order alone satisfies both constraints, and a helper that only
 * accepted table names would quietly need a cycle-breaking step it had no way to express.
 * The suite spells the order out instead.
 */
export async function clearD1(database: D1Database, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await database.prepare(statement).run();
  }
}
