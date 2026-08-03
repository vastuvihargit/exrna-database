/**
 * Storage integrity verification.
 *
 * Two failure modes matter, and they are not equally bad:
 *   • a MongoDB version row whose bytes are missing  → DATA LOSS, alert immediately
 *   • bytes on disk with no MongoDB row              → orphan, report only, never auto-delete
 *
 * Exit codes are what the cron job and the monitoring alert read:
 *   0  everything checked out
 *   1  the check could not run
 *   2  missing, truncated or corrupted objects were found — page somebody
 *
 * Run nightly, and after every restore drill.
 *
 *   npm run verify:storage                  # 2% checksum sample
 *   npm run verify:storage -- --sample=1     # re-hash everything (slow)
 *   npm run verify:storage -- --no-orphans   # skip the on-disk walk
 */
import './load-dotenv';

async function main() {
  // Imported after the environment is loaded: these modules read it at module scope.
  const { connectToDatabase, disconnectFromDatabase } = await import('../src/server/db/connection');
  const { integrityService } = await import('../src/server/services/integrity.service');
  const { getStorageProvider } = await import('../src/server/storage');

  const args = process.argv.slice(2);
  const sampleArg = args.find((arg) => arg.startsWith('--sample='));
  const sampleRate = sampleArg ? Number(sampleArg.split('=')[1]) : 0.02;
  const includeOrphans = !args.includes('--no-orphans');

  console.log('Storage integrity check');
  console.log('─'.repeat(64));

  await getStorageProvider().ensureReady();
  console.log('✓ All storage areas present');

  await connectToDatabase();

  const report = await integrityService.verifyStorageIntegrity({ sampleRate, includeOrphans });

  if (report.totalBytes && report.freeBytes !== null) {
    const usedPercent = ((1 - report.freeBytes / report.totalBytes) * 100).toFixed(1);
    console.log(
      `${report.belowFreeSpaceFloor ? '✗' : '✓'} Volume ${usedPercent}% used, ` +
        `${(report.freeBytes / 1024 ** 3).toFixed(1)} GB free`,
    );
  }

  console.log(
    `✓ Checked ${report.checkedVersions} of ${report.totalVersions} stored objects ` +
      `(${report.hashedVersions} re-hashed)`,
  );

  const critical = report.problems.filter((problem) => problem.kind !== 'orphan');
  const orphans = report.problems.filter((problem) => problem.kind === 'orphan');

  if (critical.length > 0) {
    console.error(`✗ ${critical.length} critical problem(s):`);
    for (const problem of critical.slice(0, 40)) {
      console.error(`   [${problem.kind}] version ${problem.versionId ?? '?'} — ${problem.detail}`);
    }
    process.exitCode = 2;
  } else {
    console.log('✓ No missing, truncated or corrupted objects');
  }

  if (report.orphanCount > 0) {
    // Reported, never removed. A partially restored database is exactly when this script
    // runs and exactly when deleting "orphans" would destroy real data.
    console.warn(
      `⚠ ${report.orphanCount} orphaned object(s) on disk with no version row. ` +
        'Nothing has been deleted — investigate before removing anything.',
    );
    for (const problem of orphans.slice(0, 20)) {
      console.warn(`   ${problem.area}/${problem.key}`);
    }
  }

  if (report.belowFreeSpaceFloor) {
    console.error('✗ Free space is below the configured floor');
    process.exitCode = process.exitCode === 2 ? 2 : 1;
  }

  if (report.truncated) {
    console.warn('⚠ The sweep stopped at its limit; orphan detection was skipped this run.');
  }

  console.log('─'.repeat(64));
  console.log(process.exitCode ? '✗ Integrity check reported problems' : '✓ Integrity check passed');

  await disconnectFromDatabase().catch(() => undefined);
}

main().catch((error: unknown) => {
  console.error('✗ Integrity check failed to run');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
