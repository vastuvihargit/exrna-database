/**
 * Picks up changes made directly in the Google Shared Drive.
 *
 *   npx tsx scripts/sync-drive-changes.ts [--max-pages 10] [--page-size 100]
 *
 * Run from cron, at whatever `DRIVE_SYNC_INTERVAL_MINUTES` says — 15 minutes by default. The
 * application is the main interface, but the Shared Drive is a real Shared Drive: people will
 * open it in the Drive web UI, rename things, drag them about and empty the trash. This is
 * what notices.
 *
 * **The first run applies nothing.** It takes a cursor and stops. There is deliberately no
 * attempt to catch up on what happened before synchronization was switched on: the feed does
 * not reach back that far, and pretending otherwise would mean inventing a reconcile over a
 * corpus nobody has asked us to distrust. Everything after that first run is seen.
 *
 * Safe to run concurrently with itself: the cursor advances only after a page has been
 * applied, every application is idempotent, and a second worker that got there first simply
 * causes this one to stop early.
 */
import './load-dotenv';

import { connectToDatabase, disconnectFromDatabase } from '../src/server/db/connection';
import { isDriveStorageEnabled } from '../src/server/storage/google';
import { syncDriveChanges } from '../src/server/services/drive-sync.service';
import * as organizationRepository from '../src/server/repositories/organization.repository';

function numberArg(flag: string, fallback: number, max: number): number {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

async function main(): Promise<void> {
  if (!isDriveStorageEnabled()) {
    console.log('Google Drive storage is not enabled; nothing to synchronize.');
    return;
  }

  await connectToDatabase();

  const organization = await organizationRepository.getPrimary();
  if (!organization) {
    console.error('No organization has been set up yet.');
    await disconnectFromDatabase();
    process.exit(1);
  }

  const summary = await syncDriveChanges({
    organizationId: organization.id,
    maxPages: numberArg('--max-pages', 10, 100),
    pageSize: numberArg('--page-size', 100, 1000),
  });

  if (summary.initialized) {
    console.log(
      'Starting point recorded. Changes made in the Shared Drive from now on will be picked up.',
    );
    await disconnectFromDatabase();
    return;
  }

  if (summary.reconciled) {
    console.warn(
      `The Drive change cursor had expired. Ran a full reconcile over ${summary.reconcileChecked} ` +
        'stored objects and took a fresh cursor.',
    );
  }

  console.log(
    `Read ${summary.changes} change(s) over ${summary.pages} page(s): ` +
      `${summary.contentUpdated} content update(s), ${summary.renamed} rename(s), ` +
      `${summary.trashed} trashed, ${summary.restored} restored, ${summary.missing} missing, ` +
      `${summary.conflicts} conflict(s), ${summary.unmanaged} not ours.`,
  );

  if (summary.approvalsReturnedToReview > 0) {
    console.warn(
      `${summary.approvalsReturnedToReview} approved document(s) changed and have gone back to review.`,
    );
  }

  await disconnectFromDatabase();

  // A non-zero exit tells cron a person should look. None of these implies data loss: a
  // conflict is a disagreement to resolve, a missing object still has its record and, if it
  // was migrated, its retained local copy.
  if (summary.error) {
    console.error(`Synchronization failed: ${summary.error}`);
    process.exit(1);
  }
  if (summary.conflicts > 0 || summary.missing > 0) process.exit(1);
}

main().catch(async (error: unknown) => {
  console.error('✗ Synchronization failed');
  console.error(error instanceof Error ? error.message : error);
  await disconnectFromDatabase().catch(() => undefined);
  process.exit(1);
});
