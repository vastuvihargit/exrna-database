/**
 * Moves queued uploads on to the Google Shared Drive.
 *
 *   npx tsx scripts/drain-drive-transfers.ts [--limit 50]
 *
 * Run from cron, every few minutes. Its job is the tail of the upload path: a large file is
 * stored locally and queued rather than transferred while the employee waits, and anything
 * uploaded during a Drive outage is queued too. This is what clears both.
 *
 * Safe to run concurrently with itself and with a migration job — the transfer's four
 * duplicate-prevention layers do not care who invoked it. Safe to run when Drive is down: it
 * fails every item, changes nothing, and tries again next time.
 *
 * **It can never make a file worse.** Every queued version is already complete and readable
 * from local storage; the only outcomes are "also in Drive now" and "still just here".
 */
import './load-dotenv';

import { connectToDatabase, disconnectFromDatabase } from '../src/server/db/connection';
import { getEnv } from '../src/server/config/env';
import { storageRegistry } from '../src/server/storage';
import { getGoogleDriveStorage, isDriveStorageEnabled } from '../src/server/storage/google';
import { requireDriveStore } from '../src/server/services/storage-migration/transfer';
import {
  countPending,
  drainPendingTransfers,
} from '../src/server/services/storage-migration/pending-transfers';

function parseLimit(): number {
  const index = process.argv.indexOf('--limit');
  if (index === -1) return 50;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 500) : 50;
}

async function main(): Promise<void> {
  const env = getEnv();

  if (!isDriveStorageEnabled()) {
    console.log('Google Drive storage is not enabled; nothing to do.');
    return;
  }
  if (env.DEFAULT_STORAGE_PROVIDER !== 'google_drive') {
    // Not an error: a deployment can have Drive connected for migration while new uploads
    // still go to local storage. Nothing should be queueing in that state.
    console.log('New uploads are not configured to go to Drive; nothing to do.');
    return;
  }

  await connectToDatabase();

  const before = await countPending();
  console.log(`Queued uploads waiting for the Shared Drive: ${before}`);

  if (before === 0) {
    await disconnectFromDatabase();
    return;
  }

  const store = requireDriveStore();
  const result = await drainPendingTransfers({
    deps: { store, client: getGoogleDriveStorage().client, hierarchy: storageRegistry.hierarchy('google_drive') },
    limit: parseLimit(),
  });

  const remaining = await countPending();
  console.log(
    `Moved ${result.transferred}, failed ${result.failed}, ${remaining} still waiting.`,
  );

  // A non-zero exit tells cron something needs looking at, without implying data loss —
  // every failed item is still a perfectly good file on this server.
  if (result.failed > 0) {
    console.error('Some transfers failed. The files are unaffected and remain readable.');
    await disconnectFromDatabase();
    process.exit(1);
  }

  await disconnectFromDatabase();
}

main().catch(async (error: unknown) => {
  console.error('✗ Drain failed');
  console.error(error instanceof Error ? error.message : error);
  await disconnectFromDatabase().catch(() => undefined);
  process.exit(1);
});
