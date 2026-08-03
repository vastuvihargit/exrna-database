/**
 * Scheduled health monitor.
 *
 * Runs the same checks the admin System page shows, and — unlike the page — does not
 * wait for somebody to open a browser. This is what turns "the dashboard would have
 * told you" into "you were told".
 *
 * Run every 15 minutes from cron. It is cheap: a statfs, a database ping, two small
 * JSON reads and one count.
 *
 *   npx tsx scripts/monitor.ts              # check, alert, exit with a status code
 *   npx tsx scripts/monitor.ts --dry-run    # print what would be alerted, send nothing
 *   npx tsx scripts/monitor.ts --quiet      # only print problems
 *
 * Exit codes, so an external monitor (Nagios, healthchecks.io, a Kubernetes probe) can
 * read the result without parsing anything:
 *   0  everything healthy
 *   1  the monitor itself could not run — which is its own kind of alarm
 *   2  one or more warnings
 *   3  one or more critical conditions
 */
import './load-dotenv';

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const quiet = process.argv.includes('--quiet');

  // Imported after the environment is loaded: these read it at module scope.
  const { connectToDatabase, disconnectFromDatabase } = await import('../src/server/db/connection');
  const { collectSystemStatus } = await import('../src/server/services/system.service');
  const { dispatchAlerts } = await import('../src/server/monitoring/alerts');

  await connectToDatabase();

  try {
    const status = await collectSystemStatus();

    if (!quiet || status.status !== 'ok') {
      console.log(`System status: ${status.status.toUpperCase()}`);
      console.log('─'.repeat(72));
      for (const check of status.checks) {
        if (quiet && check.severity === 'ok') continue;
        const mark = check.severity === 'ok' ? '✓' : check.severity === 'warning' ? '!' : '✗';
        const value = check.value ? `  [${check.value}]` : '';
        console.log(`${mark} ${check.label}${value}`);
        console.log(`    ${check.detail}`);
      }
      console.log('─'.repeat(72));
    }

    const outcomes = await dispatchAlerts(status.checks, { dryRun });
    const notable = outcomes.filter((outcome) => outcome.action !== 'suppressed');

    if (notable.length > 0) {
      console.log(dryRun ? 'Would have sent:' : 'Alerts dispatched:');
      for (const outcome of notable) {
        console.log(`  ${outcome.action.padEnd(10)} ${outcome.key} — ${outcome.detail}`);
      }
    } else if (!quiet) {
      const suppressed = outcomes.length;
      console.log(
        suppressed > 0
          ? `No new alerts (${suppressed} condition(s) still firing, within cooldown).`
          : 'No alerts.',
      );
    }

    return status.status === 'critical' ? 3 : status.status === 'warning' ? 2 : 0;
  } finally {
    await disconnectFromDatabase().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // A monitor that dies silently is worse than no monitor: the absence of alerts would
    // read as health. Exit 1 is deliberately distinct from "found problems".
    console.error('✗ The monitor could not run');
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
