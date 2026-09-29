/**
 * The migration gateways' read/write guarantees, without a database.
 *
 * "A dry run writes nothing" and "verification is read-only" are properties a cutover decision
 * rests on, so they are asserted against the gateways themselves rather than trusted to every
 * caller only ever passing a SELECT.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DryRunGateway,
  ReadOnlyGateway,
  WranglerGateway,
  assertReadOnly,
  literal,
  renderStatement,
} from '@/server/migration/d1/gateway';
import type { D1Gateway, Statement } from '@/server/migration/d1/types';

function recordingGateway(): D1Gateway & { runs: Statement[][]; queries: string[] } {
  const runs: Statement[][] = [];
  const queries: string[] = [];
  return {
    dryRun: false,
    label: 'recording',
    runs,
    queries,
    async run(statements) {
      runs.push(statements);
    },
    async query<T>(sql: string) {
      queries.push(sql);
      return [] as T[];
    },
  };
}

describe('assertReadOnly', () => {
  it.each([
    'SELECT id FROM files',
    '  select count(*) from users',
    'WITH x AS (SELECT id FROM files) SELECT * FROM x',
    "SELECT id FROM audit_logs WHERE action = 'file.update'",
  ])('accepts a read: %s', (sql) => {
    expect(() => assertReadOnly(sql)).not.toThrow();
  });

  it.each([
    'DELETE FROM files',
    'UPDATE users SET status = 1',
    "INSERT INTO d1_migration_runs (id) VALUES ('x')",
    'DROP TABLE files',
    'SELECT 1; DELETE FROM files',
    'WITH x AS (SELECT id FROM files) DELETE FROM files WHERE id IN (SELECT id FROM x)',
    'PRAGMA foreign_keys = OFF',
  ])('refuses anything else: %s', (sql) => {
    expect(() => assertReadOnly(sql)).toThrow(/Refusing/);
  });
});

describe('DryRunGateway', () => {
  it('never forwards a write, and reports what it would have written', async () => {
    const inner = recordingGateway();
    const dry = new DryRunGateway(inner);

    await dry.run([{ sql: 'INSERT INTO files (id) VALUES (?)', params: ['a'] }]);

    expect(inner.runs).toEqual([]);
    expect(dry.statementsSeen).toBe(1);
    expect(dry.sample[0]).toBe("INSERT INTO files (id) VALUES ('a');");
    expect(dry.dryRun).toBe(true);
  });

  it('forwards reads but refuses a write smuggled through query()', async () => {
    const inner = recordingGateway();
    const dry = new DryRunGateway(inner);

    await dry.query('SELECT id FROM files');
    expect(() => dry.query('DELETE FROM files')).toThrow(/Refusing/);
    expect(inner.queries).toEqual(['SELECT id FROM files']);
  });
});

describe('ReadOnlyGateway', () => {
  it('refuses every write', async () => {
    const inner = recordingGateway();
    const readOnly = new ReadOnlyGateway(inner);

    await expect(
      readOnly.run([{ sql: 'UPDATE files SET display_name = ?', params: ['x'] }]),
    ).rejects.toThrow(/read-only/);
    expect(inner.runs).toEqual([]);
  });
});

describe('WranglerGateway', () => {
  it('writes each batch to a kept .sql file and executes it with --file', async () => {
    const files = new Map<string, string>();
    const calls: string[][] = [];
    const gateway = new WranglerGateway({
      database: 'biotech-drive-dev',
      env: 'development',
      remote: false,
      workDir: '/tmp/run',
      writeSql: async (filePath, contents) => {
        files.set(filePath, contents);
      },
      exec: async (args) => {
        calls.push(args);
        return '[]';
      },
    });

    await gateway.run([{ sql: 'INSERT INTO t (a, b) VALUES (?, ?)', params: ["O'Brien", null] }]);

    const [contents] = [...files.values()];
    expect(contents).toBe("INSERT INTO t (a, b) VALUES ('O''Brien', NULL);\n");
    expect(calls[0]).toEqual(
      expect.arrayContaining(['d1', 'execute', 'biotech-drive-dev', '--env', 'development', '--local', '--file']),
    );
  });
});

describe('SQL rendering', () => {
  it('refuses values it cannot represent rather than mangling them', () => {
    expect(() => literal('a\u0000b')).toThrow(/NUL/);
    expect(() => literal(Number.NaN)).toThrow();
  });

  it('refuses a placeholder/parameter mismatch', () => {
    expect(() => renderStatement({ sql: 'SELECT ?', params: [] })).toThrow();
    expect(() => renderStatement({ sql: 'SELECT 1', params: [1] })).toThrow();
  });
});

describe('WranglerGateway against the real wrangler binary', () => {
  // The default `exec`, not a stub: the regression was in how the process was spawned. On
  // Windows `shell: true` split `--command SELECT COUNT(*) AS n …` into separate arguments, so
  // every verification query failed while every stubbed test passed.
  it('passes a multi-word SQL command through as one argument', async () => {
    const persistTo = await mkdtemp(path.join(os.tmpdir(), 'gateway-spawn-'));
    try {
      const gateway = new WranglerGateway({
        database: 'biotech-drive-dev',
        env: 'development',
        remote: false,
        persistTo,
        workDir: persistTo,
        writeSql: async () => undefined,
      });
      const rows = await gateway.query<{ n: number; s: string }>(
        "SELECT COUNT(*) AS n, 'two words' AS s FROM sqlite_master WHERE ? = ?",
        [1, 1],
      );
      expect(rows).toEqual([{ n: 0, s: 'two words' }]);
    } finally {
      await rm(persistTo, { recursive: true, force: true });
    }
  }, 120_000);
});
