/**
 * Purges trashed items whose retention window has passed.
 *
 * Run from cron (daily is enough). Deliberately a separate, explicit job rather than a
 * MongoDB TTL index: permanent deletion of research data must be something a person
 * scheduled and can audit, not something the database does quietly.
 *
 *   npx tsx scripts/purge-trash.ts [--dry-run]
 */
import './load-dotenv';

import { loadEnv } from '../src/server/config/env';
import { connectToDatabase, disconnectFromDatabase } from '../src/server/db/connection';
import * as fileRepository from '../src/server/repositories/file.repository';
import * as folderRepository from '../src/server/repositories/folder.repository';
import { folderService } from '../src/server/services/folder.service';

async function main() {
  const env = loadEnv();
  const dryRun = process.argv.includes('--dry-run');

  await connectToDatabase();

  const cutoff = new Date(Date.now() - env.TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expiredFolders = await folderRepository.findExpiredTrashInternal(cutoff, 1000);
  // Files are purged in the same pass because they hold the bytes: a trashed file whose
  // folder was never trashed would otherwise sit on disk and against a quota forever.
  const expiredFiles = await fileRepository.findExpiredTrash(cutoff, 1000);

  console.log(
    `Retention: ${env.TRASH_RETENTION_DAYS} days (deleted on or before ${cutoff.toISOString()})`,
  );
  console.log(`Folders eligible for permanent deletion: ${expiredFolders.length}`);
  for (const folder of expiredFolders) {
    console.log(`  - ${folder.name} (deleted ${folder.deletedAt?.toISOString()})`);
  }

  console.log(`Files eligible for permanent deletion: ${expiredFiles.length}`);
  for (const file of expiredFiles) {
    console.log(
      `  - ${file.displayName} · ${file.sizeBytes} B (deleted ${file.deletedAt?.toISOString()})`,
    );
  }

  if (dryRun) {
    console.log('\nDry run — nothing was deleted.');
  } else if (expiredFolders.length > 0 || expiredFiles.length > 0) {
    const { purged, purgedFiles, reclaimedBytes } = await folderService.purgeExpiredTrash();
    console.log(
      `\n✓ Permanently deleted ${purged} folder(s) and ${purgedFiles} file(s), reclaiming ${reclaimedBytes} bytes.`,
    );
  } else {
    console.log('\nNothing to purge.');
  }

  await disconnectFromDatabase();
}

main().catch(async (error: unknown) => {
  console.error('✗ Purge failed');
  console.error(error instanceof Error ? error.message : error);
  await disconnectFromDatabase().catch(() => undefined);
  process.exit(1);
});
