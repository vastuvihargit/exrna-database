/**
 * The D1 schema's behavioural contract.
 *
 * These assertions run against a **real local D1** through `wrangler d1 execute`, not against
 * an in-process SQLite stand-in. That is deliberate: the properties being asserted here are
 * partial unique indexes, `RAISE(ABORT)` triggers, CHECK constraints and FTS5 ranking, and
 * every one of them is a claim about what the database engine does. A different SQLite build
 * with different compile-time options could satisfy the test and not the deployment.
 *
 * What is being protected is the set of guarantees Phase 0 identified as load-bearing and
 * that the Mongo schema enforced at the database rather than in the application:
 *
 *   • one Drive file per version, forever — the duplicate-upload guard
 *   • one Drive folder per folder, forever — the duplicate-mirror guard
 *   • append-only audit log and stock ledger
 *   • stock cannot go negative
 *   • an id migrated from MongoDB is stored byte-for-byte
 *
 * Each test uses its own ids so they do not interact; the database is migrated once.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const DB = 'biotech-drive-dev';

/**
 * Wrangler's JS entry point, invoked with the current Node binary.
 *
 * **Not** `npx wrangler` through a shell. On Windows `npx` resolves to a `.cmd`, which
 * `execFileSync` can only run with `shell: true` — and a shell re-splits the arguments, so a
 * `--command "SELECT 1 AS x"` arrives as three unknown arguments and every call fails.
 *
 * That failure mode is why the guard below is a hard failure rather than a skip: the first
 * version of this file swallowed it, `available` stayed false, and all twelve tests reported
 * as passing while asserting nothing at all.
 */
const WRANGLER = path.resolve(process.cwd(), 'node_modules/wrangler/bin/wrangler.js');
const WRANGLER_ARGS = ['d1', 'execute', DB, '--env', 'development', '--local'];

interface D1Result {
  results: Record<string, unknown>[];
  success: boolean;
}

async function run(sql: string): Promise<D1Result[]> {
  const { stdout } = await execFileAsync(process.execPath, [WRANGLER, ...WRANGLER_ARGS, '--json', '--command', sql], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  // Wrangler prints banner lines before the JSON on some versions; take from the first `[`.
  const start = stdout.indexOf('[');
  return JSON.parse(stdout.slice(start)) as D1Result[];
}

/** Runs SQL that must be rejected, and returns the engine's message. */
async function expectRejected(sql: string): Promise<string> {
  try {
    await run(sql);
  } catch (error) {
    const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; message: string };
    return String(err.stderr ?? '') + String(err.stdout ?? '') + err.message;
  }
  throw new Error(`Expected the database to reject this statement, but it succeeded:\n${sql}`);
}

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  return (await run(sql))[0]?.results ?? [];
}

/**
 * 24-character ObjectId-shaped hex ids, as the migration will preserve them.
 *
 * Two flavours, and the distinction is what makes this suite re-runnable:
 *
 *   `oid`    — stable across runs. Used only for the shared fixtures, which are inserted with
 *              `INSERT OR IGNORE` and never mutated, so a second run adopts them unchanged.
 *
 *   `runOid` — unique per run. Used by every test that inserts or mutates.
 *
 * The first version of this file used stable ids everywhere. It passed against a fresh
 * database and failed on every subsequent run: the inventory batch was still at 60 from the
 * previous run's legitimate issue, so the overdraw assertion compared against the wrong
 * starting quantity. `audit_logs` and `stock_transactions` make the problem unavoidable
 * rather than merely awkward — the immutability triggers this suite exists to prove mean
 * their rows *cannot* be cleaned up between runs, so unique ids are the only option.
 */
const oid = (suffix: string) => `6a6ae146e89e7c6f88${suffix.padStart(6, '0')}`;

/** 12 hex characters of run entropy, so two runs never collide on a primary key. */
const RUN = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const runOid = (suffix: string) => `${RUN}${suffix.padStart(12, '0')}`;

const ORG = oid('a10001');
const USER = oid('a10002');
const DEPT = oid('a10003');
const FOLDER = oid('a10004');
const FILE = oid('a10005');

/**
 * A second, run-scoped file that the version tests hang off.
 *
 * `ux_file_versions_number` is unique on `(file_id, version_number)`, so versions inserted
 * against the shared fixture file would collide with the previous run's. The fixture file
 * stays for the read-only assertions (identifier preservation, FTS).
 */
const RUN_FILE = runOid('a10006');

beforeAll(async () => {
  /**
   * Fail loudly, never skip.
   *
   * `vitest.config.ts` already records the project's position on this: a suite that skips
   * silently "is a far worse outcome than a slower run", because a green run then means
   * nothing. These assertions are the schema's security guarantees — the duplicate-upload
   * guard, the append-only ledger, the negative-stock floor — and a run that quietly does not
   * check them is indistinguishable from one that does.
   */
  try {
    await run('SELECT 1 AS ok');
  } catch (error) {
    throw new Error(
      'The D1 schema contract suite could not reach the local database.\n\n' +
        'Create it and apply the migrations first:\n' +
        '  npx wrangler d1 migrations apply biotech-drive-dev --env development --local\n\n' +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Base fixtures every test hangs off. `INSERT OR IGNORE` so a re-run is a no-op.
  await run(`
    INSERT OR IGNORE INTO organizations (id, name, slug, settings, created_at, updated_at)
      VALUES ('${ORG}', 'Test Org', 'test-org-contract', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT OR IGNORE INTO users (id, organization_id, email, email_domain, name, storage_quota_bytes, created_at, updated_at)
      VALUES ('${USER}', '${ORG}', 'contract@company.com', 'company.com', 'Contract Tester', 1000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT OR IGNORE INTO departments (id, organization_id, name, code, storage_quota_bytes, created_at, updated_at)
      VALUES ('${DEPT}', '${ORG}', 'Toxicology', 'TOX-CT', 1000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT OR IGNORE INTO folders (id, organization_id, name, name_lower, drive_type, owner_id, created_by, created_at, updated_at)
      VALUES ('${FOLDER}', '${ORG}', 'Protocols', 'protocols', 'department', '${USER}', '${USER}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT OR IGNORE INTO files (id, organization_id, display_name, display_name_lower, original_filename, extension, folder_id, drive_type, owner_id, created_by, created_at, updated_at)
      VALUES ('${FILE}', '${ORG}', 'Tox Study Protocol.pdf', 'tox study protocol.pdf', 'Tox-Study-Protocol.pdf', 'pdf', '${FOLDER}', 'department', '${USER}', '${USER}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT OR IGNORE INTO files (id, organization_id, display_name, display_name_lower, original_filename, extension, folder_id, drive_type, owner_id, created_by, created_at, updated_at)
      VALUES ('${RUN_FILE}', '${ORG}', 'Versioned ${RUN}.pdf', 'versioned ${RUN}.pdf', 'Versioned.pdf', 'pdf', '${FOLDER}', 'department', '${USER}', '${USER}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
}, 300_000);

function versionInsert(id: string, versionNumber: number, driveId: string | null): string {
  const drive = driveId === null ? 'NULL' : `'${driveId}'`;
  return `INSERT INTO file_versions
    (id, organization_id, file_id, version_number, storage_key, storage_area, original_filename,
     file_size, mime_type, extension, checksum_sha256, uploaded_by, uploaded_at,
     google_drive_file_id, created_at, updated_at)
    VALUES ('${id}', '${ORG}', '${RUN_FILE}', ${versionNumber}, 'key/${id}', 'versions',
            'Tox-Study-Protocol.pdf', 1024, 'application/pdf', 'pdf', 'abc123', '${USER}',
            '2026-01-01T00:00:00.000Z', ${drive}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
}

describe('identifier preservation', () => {
  it('stores a MongoDB ObjectId byte-for-byte', async () => {
    const found = await rows(`SELECT id FROM files WHERE id = '${FILE}'`);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(FILE);
    // 24 hex characters — not re-encoded, not truncated, not lowercased into something else.
    expect(String(found[0]!.id)).toMatch(/^[a-f0-9]{24}$/);
  }, 120_000);
});

describe('one Drive file per version, forever', () => {
  it('refuses a second version claiming the same Drive file id', async () => {
    const driveId = `1AbCdEfGhIjKlMnOpQrStUv_${RUN}`;

    await run(versionInsert(runOid('b10001'), 101, driveId));
    const message = await expectRejected(versionInsert(runOid('b10002'), 102, driveId));

    // The failure must come from the index, not from a coincidence.
    expect(message).toMatch(/UNIQUE constraint failed|ux_file_versions_drive_id/i);
  }, 180_000);

  it('still allows many versions that have not been migrated yet', async () => {
    // The index is partial. If it were not, the second NULL would collide and every
    // un-migrated version after the first would be unwritable.
    await run(versionInsert(runOid('b10003'), 103, null));
    await run(versionInsert(runOid('b10004'), 104, null));

    const found = await rows(
      `SELECT count(*) AS n FROM file_versions WHERE file_id = '${RUN_FILE}' AND google_drive_file_id IS NULL`,
    );
    expect(Number(found[0]!.n)).toBeGreaterThanOrEqual(2);
  }, 180_000);
});

describe('one Drive folder per folder, forever', () => {
  it('refuses a second folder claiming the same Drive folder id', async () => {
    const driveFolderId = `1ZyXwVuTsRqPoNmLkJi_${RUN}`;

    const insert = (id: string, name: string) =>
      `INSERT INTO folders (id, organization_id, name, name_lower, drive_type, owner_id, created_by,
        google_drive_folder_id, created_at, updated_at)
       VALUES ('${id}', '${ORG}', '${name}', '${name.toLowerCase()}', 'department', '${USER}', '${USER}',
               '${driveFolderId}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;

    await run(insert(runOid('c10001'), `MirrorA-${RUN}`));
    const message = await expectRejected(insert(runOid('c10002'), `MirrorB-${RUN}`));

    expect(message).toMatch(/UNIQUE constraint failed|ux_folders_drive_id/i);
  }, 180_000);
});

describe('append-only history', () => {
  it('refuses to modify or delete an audit log entry', async () => {
    const id = runOid('d10001');
    await run(
      `INSERT INTO audit_logs (id, organization_id, actor_user_id, action, entity_type, entity_id, created_at)
       VALUES ('${id}', '${ORG}', '${USER}', 'file.approve', 'file', '${FILE}', '2026-01-01T00:00:00.000Z')`,
    );

    expect(await expectRejected(`UPDATE audit_logs SET reason = 'tampered' WHERE id = '${id}'`)).toMatch(
      /append-only/i,
    );
    expect(await expectRejected(`DELETE FROM audit_logs WHERE id = '${id}'`)).toMatch(/append-only/i);

    // Still there, unchanged.
    const found = await rows(`SELECT reason FROM audit_logs WHERE id = '${id}'`);
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toBeNull();
  }, 240_000);

  it('refuses to modify or delete a stock transaction', async () => {
    const itemId = runOid('e10001');
    const txId = runOid('e10002');

    // Batched — see the note in the negative-stock test on why.
    await run(`
      INSERT OR IGNORE INTO inventory_items
        (id, organization_id, name, code, category, unit, created_by, created_at, updated_at)
        VALUES ('${itemId}', '${ORG}', 'Acetonitrile', 'CHM-${RUN}-01', 'chemical', 'mL', '${USER}',
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO stock_transactions
        (id, organization_id, item_id, item_code, item_name, action, quantity, quantity_delta,
         previous_quantity, new_quantity, unit, performed_at, created_at)
        VALUES ('${txId}', '${ORG}', '${itemId}', 'CHM-${RUN}-01', 'Acetonitrile', 'added', 500, 500, 0, 500,
                'mL', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    expect(
      await expectRejected(`UPDATE stock_transactions SET quantity = 5000 WHERE id = '${txId}'`),
    ).toMatch(/append-only/i);
    expect(await expectRejected(`DELETE FROM stock_transactions WHERE id = '${txId}'`)).toMatch(
      /append-only/i,
    );
  }, 240_000);
});

describe('stock cannot go negative', () => {
  /**
   * The MongoDB implementation made the availability check and the decrement one atomic
   * `findOneAndUpdate` with a `quantity: { $gte: n }` filter, so there was no read-then-write
   * window. D1 has no interactive transactions, so the same property has to come from a
   * conditional UPDATE. This asserts it does.
   */
  it('leaves the batch untouched when the conditional decrement would overdraw', async () => {
    const itemId = runOid('f10001');
    const batchId = runOid('f10002');

    /**
     * Setup, the overdraw attempt and the legitimate issue in one round trip.
     *
     * Batched because every `await run()` spawns a fresh wrangler process (~4 s) and blocks the
     * worker's event loop while it does — six sequential calls in one test is what made
     * vitest's reporter RPC time out. The two `SELECT`s at the end are the assertions, and
     * they read the state the two `UPDATE`s left behind, so nothing is lost by batching.
     */
    const result = await run(`
      INSERT OR IGNORE INTO inventory_items
        (id, organization_id, name, code, category, unit, available_quantity, created_by, created_at, updated_at)
        VALUES ('${itemId}', '${ORG}', 'Methanol', 'CHM-${RUN}-02', 'chemical', 'mL', 100, '${USER}',
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT OR IGNORE INTO inventory_batches
        (id, item_id, batch_number, quantity, received_at, created_at)
        VALUES ('${batchId}', '${itemId}', 'B-001', 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      -- Issuing more than is on the shelf must match no rows: not throw, not go negative.
      UPDATE inventory_batches SET quantity = quantity - 150 WHERE id = '${batchId}' AND quantity >= 150;
      SELECT quantity AS after_overdraw FROM inventory_batches WHERE id = '${batchId}';

      -- A legitimate issue does apply.
      UPDATE inventory_batches SET quantity = quantity - 40 WHERE id = '${batchId}' AND quantity >= 40;
      SELECT quantity AS after_issue FROM inventory_batches WHERE id = '${batchId}';
    `);

    const afterOverdraw = result.flatMap((r) => r.results).find((r) => 'after_overdraw' in r);
    const afterIssue = result.flatMap((r) => r.results).find((r) => 'after_issue' in r);

    expect(Number(afterOverdraw!.after_overdraw)).toBe(100);
    expect(Number(afterIssue!.after_issue)).toBe(60);
  }, 240_000);

  it('refuses a negative quantity even from a hand-written statement', async () => {
    const itemId = runOid('f20001');
    const batchId = runOid('f20002');

    await run(`
      INSERT OR IGNORE INTO inventory_items
        (id, organization_id, name, code, category, unit, created_by, created_at, updated_at)
        VALUES ('${itemId}', '${ORG}', 'Ethanol', 'CHM-${RUN}-03', 'chemical', 'mL', '${USER}',
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT OR IGNORE INTO inventory_batches
        (id, item_id, batch_number, quantity, received_at, created_at)
        VALUES ('${batchId}', '${itemId}', 'B-001', 10, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    // The CHECK constraint is the belt to the conditional UPDATE's braces: even an operator
    // running SQL directly during an incident cannot drive a batch negative.
    expect(
      await expectRejected(`UPDATE inventory_batches SET quantity = -5 WHERE id = '${batchId}'`),
    ).toMatch(/CHECK constraint failed|ck_inventory_batches_quantity/i);
  }, 180_000);
});

describe('full-text search', () => {
  /**
   * Renamed in Phase 3, module 3. It used to say "…and ranks it with the Mongo weights", which
   * it has never checked — there is one document in the fixture, so any ordering passes. The
   * weights in the old query were also shifted by one (`bm25` takes a weight per column
   * *including* the UNINDEXED `file_id`), so the assertion was doubly not what it claimed.
   *
   * Ranking is asserted for real in `project-experiment-repository.test.ts`, against a corpus
   * where the order can actually differ. The files_fts equivalent belongs with the file
   * repository, in module 4.
   */
  it('finds a file by name through the trigger-maintained index', async () => {
    // The insert trigger populates the index; no application step is involved.
    const found = await rows(
      `SELECT file_id, bm25(files_fts, 0.0, 10.0, 6.0, 5.0, 1.0) AS rank
         FROM files_fts WHERE files_fts MATCH 'protocol' ORDER BY rank`,
    );
    expect(found.map((row) => row.file_id)).toContain(FILE);
  }, 120_000);

  it('does not match a file by its id', async () => {
    // `file_id` is UNINDEXED. If it were not, pasting an id into the search box would surface
    // the record regardless of whether the searcher is allowed to see it.
    const found = await rows(`SELECT file_id FROM files_fts WHERE files_fts MATCH '"${FILE}"'`);
    expect(found).toHaveLength(0);
  }, 120_000);
});

describe('the permission catalogue', () => {
  it('matches the application vocabulary exactly', async () => {
    const { PERMISSIONS } = await import('@/server/domain/permissions');

    const seeded = (await rows('SELECT key FROM permissions ORDER BY key')).map((row) => String(row.key));
    expect(seeded).toEqual([...PERMISSIONS].sort());
  }, 120_000);

  it('refuses a role permission that is not in the catalogue', async () => {
    const roleId = runOid('a20001');
    await run(`INSERT OR IGNORE INTO roles (id, organization_id, key, name, rank, created_at, updated_at)
         VALUES ('${roleId}', '${ORG}', 'contract-role-${RUN}', 'Contract Role', 10,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);

    // A typo'd permission must fail at insert rather than silently granting nothing — which
    // is the whole reason `permissions` is a table with a foreign key rather than a string.
    expect(
      await expectRejected(
        `INSERT INTO role_permissions (role_id, permission_key) VALUES ('${roleId}', 'file.veiw')`,
      ),
    ).toMatch(/FOREIGN KEY constraint failed|CHECK constraint/i);
  }, 180_000);
});
