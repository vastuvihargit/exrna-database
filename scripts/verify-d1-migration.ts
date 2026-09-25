/**
 * Compares a migrated D1 database against the MongoDB it came from.
 *
 *   npm run migrate:verify -- --env development --local
 *   npm run migrate:verify -- --env production --remote --report reports/verify.json
 *
 * Read-only on both databases. Exit code is non-zero if any count differs or any error-severity
 * check returns rows, so it can gate a cutover step in a script.
 *
 * Run it twice during a cutover: once after the bulk load, and again after the final delta pass.
 * The second run is the one that matters — the first is against a source that is still moving.
 */
import './load-dotenv';

import fs from 'node:fs/promises';
import path from 'node:path';
import { connectToDatabase } from '@/server/db/connection';
import { ReadOnlyGateway, WranglerGateway, defaultWorkDir } from '@/server/migration/d1/gateway';
import { verifyMigration } from '@/server/migration/d1/verify';

function value(flag: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
  return next;
}

/**
 * Writes a batch file for `WranglerGateway`.
 *
 * Lives here rather than in `src/server/**` because that tree does not touch the filesystem —
 * a module that can write to disk is a module that cannot run in a Worker, and the eslint
 * boundary enforces it. The files are kept after the run: they are the exact bytes applied to
 * the database, which is the artefact an incident review asks for.
 */
async function writeSql(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

async function main(): Promise<void> {
  const env = value('--env', 'development') as string;
  const database = value('--database', `biotech-drive-${env === 'development' ? 'dev' : env}`) as string;

  await connectToDatabase();

  const gateway = new ReadOnlyGateway(new WranglerGateway({
    database,
    env,
    remote: process.argv.includes('--remote'),
    workDir: defaultWorkDir('verify'),
    writeSql,
  }));

  const report = await verifyMigration({
    gateway,
    aclSample: Number(value('--acl-sample', '200')),
    ftsSample: Number(value('--fts-sample', '25')),
    onProgress: (message) => console.log(`  ${message}`),
  });

  console.log('\nRow counts\n');
  console.log(`${'table'.padEnd(30)}${'mongo'.padEnd(10)}${'d1'.padEnd(10)}delta`);
  for (const count of report.counts) {
    const flag = count.ok ? '' : '   <-- MISMATCH';
    const note = count.note ? `   (${count.note})` : '';
    console.log(
      count.table.padEnd(30) +
        String(count.source).padEnd(10) +
        String(count.target).padEnd(10) +
        String(count.delta) +
        flag +
        note,
    );
  }

  console.log(`\nACL comparison: ${report.aclSampled} resource(s) compared entry by entry`);
  console.log(`Search check:   ${report.ftsChecked} file(s) searched for by their own name`);

  if (report.findings.length === 0) {
    console.log('\nNo integrity findings.');
  } else {
    console.log('\nFindings\n');
    for (const finding of report.findings) {
      console.log(`[${finding.severity}] ${finding.check}`);
      console.log(`  ${finding.detail}`);
      for (const sample of finding.sample.slice(0, 10)) console.log(`    ${sample}`);
    }
  }

  const reportPath = value('--report');
  if (reportPath) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\nReport written to ${reportPath}`);
  }

  console.log(`\n${report.ok ? 'PASS' : 'FAIL'}`);
  if (!report.ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const mongoose = (await import('mongoose')).default;
    await mongoose.disconnect();
  });
