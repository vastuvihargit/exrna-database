/**
 * Removes abandoned uploads and the quarantined bytes they were holding.
 *
 * Run from cron, more often than the trash purge — hourly is reasonable. An upload that
 * was authorized but never finished leaves a quarantine object and a session row; without
 * this job the quarantine tree grows for every closed laptop lid and every dropped
 * connection, and the storage a user is charged for never comes back.
 *
 * Unlike `purge-trash`, nothing here is user-visible data: an incomplete upload never
 * became a file, so there is nothing to restore and no retention question to answer
 * beyond `INCOMPLETE_UPLOAD_RETENTION_HOURS`.
 *
 *   npx tsx scripts/cleanup-uploads.ts [--dry-run]
 */
import './load-dotenv';

import { loadEnv } from '../src/server/config/env';
import { connectToDatabase, disconnectFromDatabase } from '../src/server/db/connection';
import * as uploadSessionRepository from '../src/server/repositories/upload-session.repository';
import { uploadService } from '../src/server/services/upload.service';

async function main() {
  const env = loadEnv();
  const dryRun = process.argv.includes('--dry-run');

  await connectToDatabase();

  const now = new Date();
  const expired = await uploadSessionRepository.listExpired(now, 1000);

  console.log(
    `Retention: ${env.INCOMPLETE_UPLOAD_RETENTION_HOURS} hours (expired on or before ${now.toISOString()})`,
  );
  console.log(`Incomplete uploads eligible for cleanup: ${expired.length}`);

  for (const session of expired) {
    const received = session.chunkSize > 0 ? `${session.receivedChunks.length} chunk(s)` : `${session.receivedBytes} B`;
    console.log(
      `  - ${session.displayName} [${session.status}] ${received} of ${session.declaredSize} B declared`,
    );
  }

  if (dryRun) {
    console.log('\nDry run — nothing was deleted.');
  } else if (expired.length > 0) {
    // The service deletes the bytes before the record, because the record is the only
    // pointer to the quarantined object.
    const { sessions } = await uploadService.cleanupExpired();
    console.log(`\n✓ Removed ${sessions} upload session(s) and their quarantined bytes.`);
  } else {
    console.log('\nNothing to clean up.');
  }

  await disconnectFromDatabase();
}

main().catch(async (error: unknown) => {
  console.error('✗ Upload cleanup failed');
  console.error(error instanceof Error ? error.message : error);
  await disconnectFromDatabase().catch(() => undefined);
  process.exit(1);
});
