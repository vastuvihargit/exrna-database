/**
 * Re-checks approvals whose content lives in the Google Shared Drive.
 *
 *   npx tsx scripts/check-approved-content.ts [--limit 100] [--all]
 *
 * Run from cron, hourly or nightly. It asks Drive one question per live approval — is this
 * still the revision that was signed off? — and sends any document that has changed back to
 * needing review.
 *
 * **It can never lose an approval record.** A superseded approval keeps its approver, its
 * timestamp, its review request and its decisions; what changes is that the file stops
 * *claiming* to be approved, which is the whole point. Nothing is deleted and no content is
 * touched.
 *
 * Safe to run concurrently with itself and with everything else. A Drive outage during a run
 * shows up as a non-zero `unavailable` count and changes nothing: those approvals are checked
 * again next time, because "we could not tell" must never be recorded as "it is fine".
 */
import './load-dotenv';

import { connectToDatabase, disconnectFromDatabase } from '../src/server/db/connection';
import { isDriveStorageEnabled } from '../src/server/storage/google';
import { sweepRemoteApprovals } from '../src/server/services/approval-integrity.service';
import {
  countLiveRemoteApprovals,
  countSupersededApprovals,
} from '../src/server/repositories/file-version.repository';

function parseLimit(): number {
  const index = process.argv.indexOf('--limit');
  if (index === -1) return 100;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 500) : 100;
}

async function main(): Promise<void> {
  if (!isDriveStorageEnabled()) {
    console.log('Google Drive storage is not enabled; nothing to check.');
    return;
  }

  await connectToDatabase();

  const total = await countLiveRemoteApprovals();
  console.log(`Live approvals backed by the Shared Drive: ${total}`);

  if (total === 0) {
    await disconnectFromDatabase();
    return;
  }

  const limit = parseLimit();
  // `--all` walks the whole corpus in pages of `limit`. Without it a single page runs, which
  // is the right shape for a frequent cron: the sweep makes progress every run and never
  // becomes one long burst against a quota shared with employees' uploads and downloads.
  const walkEverything = process.argv.includes('--all');

  let cursor: string | null = null;
  let checked = 0;
  let superseded = 0;
  let unavailable = 0;
  let missing = 0;

  do {
    const page = await sweepRemoteApprovals({ limit, cursor });
    checked += page.checked;
    superseded += page.superseded;
    unavailable += page.unavailable;
    missing += page.missing;
    cursor = page.nextCursor;
  } while (walkEverything && cursor);

  const stale = await countSupersededApprovals();

  console.log(
    `Checked ${checked}: ${superseded} returned to review, ${missing} missing from Drive, ` +
      `${unavailable} could not be checked.`,
  );
  console.log(`Approvals currently marked stale and awaiting re-review: ${stale}`);
  if (cursor) console.log(`More to check. Next run resumes automatically.`);

  // A non-zero exit tells cron something needs a person's attention. Neither outcome implies
  // data loss: a returned-to-review document is intact, and an unreachable one still has its
  // record, its history and — if it was migrated — its retained local copy.
  const needsAttention = superseded > 0 || missing > 0 || unavailable > 0;

  await disconnectFromDatabase();
  if (needsAttention) process.exit(1);
}

main().catch(async (error: unknown) => {
  console.error('✗ Approval check failed');
  console.error(error instanceof Error ? error.message : error);
  await disconnectFromDatabase().catch(() => undefined);
  process.exit(1);
});
