/**
 * MongoDB → D1 metadata migration.
 *
 *   npm run migrate:d1                                   rehearse (dry run, the default); add --offline with no D1
 *   npm run migrate:d1 -- --env development --write      load the local wrangler database
 *   npm run migrate:d1 -- --env production --remote --write --confirm production   the cutover
 *   npm run migrate:d1 -- --resume <runId>               continue an interrupted run
 *   npm run migrate:d1 -- --since 2026-08-12T09:00:00Z   the final delta pass
 *   npm run migrate:d1 -- --steps folders,folder-hierarchy
 *
 * Every run writes a JSON report to `--report <path>` (default
 * `migration-reports/<runId>.json`) and exits non-zero if anything failed. The report is the
 * artefact a cutover decision is made from, so it is written even when the run fails.
 *
 * **`--dry-run` is the default.** Writing to a database requires saying so, because the
 * difference between a rehearsal and a cutover should never be a flag somebody forgot.
 */
import './load-dotenv';

import fs from 'node:fs/promises';
import path from 'node:path';
import { connectToDatabase } from '@/server/db/connection';
import {
  DryRunGateway,
  OfflineGateway,
  WranglerGateway,
  defaultWorkDir,
} from '@/server/migration/d1/gateway';
import { MIGRATION_STEPS } from '@/server/migration/d1/registry';
import { runMigration } from '@/server/migration/d1/runner';
import { validateSource } from '@/server/migration/d1/validate-source';
import type { D1Gateway, MigrationReport } from '@/server/migration/d1/types';

interface Options {
  dryRun: boolean;
  env: string;
  database: string | null;
  remote: boolean;
  persistTo: string | null;
  runId: string | null;
  resume: boolean;
  since: Date | null;
  steps: string[];
  reportPath: string | null;
  pageSize: number;
  skipValidation: boolean;
  listSteps: boolean;
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index === -1) return null;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };

  const env = value('--env') ?? 'development';
  const since = value('--since');
  const resume = value('--resume');
  const dryRun = !argv.includes('--write');

  // An unparseable `--since` becomes `Invalid Date`, which Mongo compares as "matches nothing":
  // a delta pass that reports success having copied no changes at all.
  const sinceDate = since ? new Date(since) : null;
  if (sinceDate && Number.isNaN(sinceDate.getTime())) {
    throw new Error(`--since "${since}" is not a date. Use ISO 8601, e.g. 2026-08-12T09:00:00Z`);
  }

  const pageSize = Number(value('--page-size') ?? 250);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error('--page-size must be an integer between 1 and 1000');
  }

  // Writing to production is the one invocation that cannot be taken back, so it has to be
  // spelled out twice. A shell-history recall of a staging command with the env edited is the
  // accident this is for.
  if (!dryRun && env === 'production' && value('--confirm') !== 'production') {
    throw new Error('Writing to production requires --confirm production');
  }

  return {
    // The safe default, and the only way to change it is to ask.
    dryRun,
    env,
    database: value('--database') ?? `biotech-drive-${env === 'development' ? 'dev' : env}`,
    remote: argv.includes('--remote'),
    persistTo: value('--persist-to'),
    runId: resume ?? value('--run-id'),
    resume: resume !== null,
    since: sinceDate,
    steps: (value('--steps') ?? '')
      .split(',')
      .map((step) => step.trim())
      .filter(Boolean),
    reportPath: value('--report'),
    pageSize,
    skipValidation: argv.includes('--skip-validation'),
    listSteps: argv.includes('--list-steps'),
  };
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

function buildGateway(options: Options): D1Gateway {
  // A dry run with no target at all — useful before the databases exist, which is the state a
  // repository is in long before a Cloudflare account is.
  if (options.dryRun && process.argv.includes('--offline')) {
    return new DryRunGateway(new OfflineGateway());
  }

  const gateway = new WranglerGateway({
    database: options.database as string,
    env: options.env,
    remote: options.remote,
    ...(options.persistTo ? { persistTo: options.persistTo } : {}),
    workDir: defaultWorkDir(options.runId ?? 'adhoc'),
    writeSql,
  });

  return options.dryRun ? new DryRunGateway(gateway) : gateway;
}

function printReport(report: MigrationReport): void {
  const pad = (text: string, width: number) => text.padEnd(width);
  console.log('');
  console.log(`Run ${report.runId} against ${report.target}`);
  console.log(report.dryRun ? 'DRY RUN — nothing was written' : 'LIVE — the target was written');
  if (report.delta) console.log(`Delta: documents changed at or after ${report.delta}`);
  console.log('');
  console.log(
    `${pad('step', 26)}${pad('source', 9)}${pad('read', 9)}${pad('written', 9)}${pad('skipped', 9)}${pad('failed', 8)}status`,
  );
  for (const step of report.steps) {
    console.log(
      pad(step.step, 26) +
        pad(String(step.sourceCount), 9) +
        pad(String(step.read), 9) +
        pad(String(step.written), 9) +
        pad(String(step.skipped), 9) +
        pad(String(step.failed), 8) +
        step.status,
    );
  }
  console.log('');
  console.log(
    `Totals: ${report.totals.read} read, ${report.totals.written} written, ` +
      `${report.totals.skipped} skipped, ${report.totals.failed} failed in ${Math.round(report.durationMs / 1000)} s`,
  );

  const withSkips = report.steps.filter((step) => step.skips.length > 0);
  if (withSkips.length > 0) {
    console.log('\nSkipped records (a sample; the reason is the interesting part):');
    for (const step of withSkips) {
      for (const skip of step.skips.slice(0, 5)) {
        console.log(`  ${step.step} ${skip.sourceId}: ${skip.reason}`);
      }
    }
  }

  const withFailures = report.steps.filter((step) => step.failures.length > 0);
  if (withFailures.length > 0) {
    console.log('\nFailures (full list in d1_migration_failures):');
    for (const step of withFailures) {
      for (const failure of step.failures.slice(0, 5)) {
        console.log(`  ${step.step} ${failure.sourceId}: ${failure.reason}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.listSteps) {
    for (const step of MIGRATION_STEPS) {
      console.log(`${step.name.padEnd(26)}${step.targets.join(', ')}`);
    }
    return;
  }

  await connectToDatabase();

  if (!options.skipValidation) {
    console.log('Validating the MongoDB source…\n');
    const validation = await validateSource((message) => console.log(`  ${message}`));
    const blockers = validation.issues.filter((issue) => issue.severity === 'blocker');

    for (const issue of validation.issues) {
      console.log(`\n[${issue.severity}] ${issue.check} — ${issue.count}`);
      console.log(`  ${issue.detail}`);
      for (const sample of issue.sample.slice(0, 5)) console.log(`    ${sample}`);
    }

    if (blockers.length > 0 && !options.dryRun) {
      console.error(
        `\nRefusing to write: ${blockers.length} blocking issue(s) in the source. ` +
          'Each one aborts the batch it lands in, which loses the other records in that batch. ' +
          'Fix them in MongoDB, or re-run with --skip-validation having decided the loss is ' +
          'acceptable and knowing which records it is.',
      );
      process.exitCode = 2;
      return;
    }
    if (validation.issues.length === 0) console.log('  no issues\n');
  }

  const gateway = buildGateway(options);
  const report = await runMigration({
    gateway,
    steps: options.steps,
    delta: { since: options.since },
    pageSize: options.pageSize,
    ...(options.runId ? { runId: options.runId } : {}),
    resume: options.resume,
    onProgress: (message) => console.log(`  ${message}`),
  });

  printReport(report);

  const reportPath =
    options.reportPath ?? path.join('migration-reports', `${report.runId}.json`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nReport written to ${reportPath}`);

  if (gateway instanceof DryRunGateway) {
    console.log(`${gateway.statementsSeen} statement(s) would have been executed. First few:`);
    for (const statement of gateway.sample.slice(0, 5)) {
      console.log(`  ${statement.slice(0, 160)}`);
    }
  }

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
