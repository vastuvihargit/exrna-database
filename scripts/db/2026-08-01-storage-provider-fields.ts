/**
 * Phase 3 database migration — Google Shared Drive storage fields.
 *
 *   npx tsx scripts/db/2026-08-01-storage-provider-fields.ts [--dry-run]
 *
 * ── Two deliberate non-actions ─────────────────────────────────────────────────────────
 *
 * **It does not backfill.** Not one `updateMany`. Every field added in Phase 3 has a schema
 * default, and Mongoose applies a default on read for a path that is absent from the stored
 * document — so an existing `FileVersion` already behaves as `storageProvider: 'local'`,
 * `migrationStatus: 'not_started'`, `localCopyState: 'present'` without being rewritten.
 * Writing 100,000 documents to store values that are already their defaults would take a
 * long write lock, bloat the oplog, and buy exactly nothing. The one thing it must not do
 * is make the queries depend on the field being present, which is why the partial indexes
 * below key on `$type: 'string'` and on explicit values rather than on absence.
 *
 * **It does not drop anything.** `createIndexes()` adds what is declared and missing;
 * `syncIndexes()` would also *drop* every live index not currently declared, which in a
 * migration script is a foot-gun aimed at a production database. Dropping an index that has
 * become genuinely obsolete stays a separate, deliberate act.
 *
 * Consequently the script is idempotent: a second run reports zero new indexes and changes
 * nothing. That is asserted by a test, not just claimed here.
 */
import '../load-dotenv';

import type { Model } from 'mongoose';

import { connectToDatabase, disconnectFromDatabase } from '../../src/server/db/connection';
import { FileModel } from '../../src/server/db/models/file.model';
import { FileVersionModel } from '../../src/server/db/models/file-version.model';
import { FolderModel } from '../../src/server/db/models/folder.model';
import { StorageMigrationJobModel } from '../../src/server/db/models/storage-migration-job.model';
import { StorageMigrationItemModel } from '../../src/server/db/models/storage-migration-item.model';
import { StorageRecoveryItemModel } from '../../src/server/db/models/storage-recovery-item.model';
import { DriveSyncStateModel } from '../../src/server/db/models/drive-sync-state.model';

/** Extended in place; the four below are new collections and start empty. */
const EXTENDED = [FileVersionModel, FolderModel, FileModel];
const CREATED = [
  StorageMigrationJobModel,
  StorageMigrationItemModel,
  StorageRecoveryItemModel,
  DriveSyncStateModel,
];

async function liveIndexNames(model: Model<unknown>): Promise<Set<string>> {
  try {
    const indexes = (await model.collection.indexes()) as Array<{ name?: string }>;
    return new Set(indexes.map((index) => index.name).filter((n): n is string => Boolean(n)));
  } catch {
    // The collection does not exist yet — normal for the four new ones on a first run.
    return new Set();
  }
}

export async function run(options: { dryRun?: boolean } = {}): Promise<{
  created: string[];
  alreadyPresent: number;
}> {
  const created: string[] = [];
  let alreadyPresent = 0;

  for (const model of [...EXTENDED, ...CREATED]) {
    const typed = model as unknown as Model<unknown>;
    const before = await liveIndexNames(typed);

    if (options.dryRun) {
      // `createIndexes` is the only way to know what Mongoose would build, so a dry run
      // reports the declared set against what is live rather than pretending to simulate it.
      const declared = typed.schema.indexes().length;
      console.log(`  ${typed.modelName.padEnd(22)} ${before.size} live, ${declared} declared`);
      continue;
    }

    await typed.createIndexes();
    const after = await liveIndexNames(typed);

    for (const name of after) {
      if (before.has(name)) alreadyPresent += 1;
      else created.push(`${typed.modelName}.${name}`);
    }
  }

  return { created, alreadyPresent };
}

/**
 * Reports how many documents predate the new fields. Purely informational — it is the
 * evidence that a backfill was correctly skipped, not a step that changes anything.
 */
async function reportUnmigratedDocuments(): Promise<void> {
  const [versionsWithoutProvider, totalVersions, foldersWithoutProvider] = await Promise.all([
    FileVersionModel.countDocuments({ storageProvider: { $exists: false } }),
    FileVersionModel.countDocuments({}),
    FolderModel.countDocuments({ storageProvider: { $exists: false } }, { withDeleted: true }),
  ]);

  console.log(`\nDocuments predating these fields (no backfill needed, defaults apply on read):`);
  console.log(`  file versions : ${versionsWithoutProvider} of ${totalVersions}`);
  console.log(`  folders       : ${foldersWithoutProvider}`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  await connectToDatabase();

  console.log('Phase 3 — Google Shared Drive storage fields');
  console.log('────────────────────────────────────────────────────────────────');
  console.log(dryRun ? 'DRY RUN — no index will be built.\n' : 'Building declared indexes.\n');

  const { created, alreadyPresent } = await run({ dryRun });

  if (!dryRun) {
    if (created.length === 0) {
      console.log(`  Nothing to do — all ${alreadyPresent} declared indexes already exist.`);
    } else {
      for (const name of created) console.log(`  + ${name}`);
      console.log(`\n  Created ${created.length}, ${alreadyPresent} already present.`);
    }
    await reportUnmigratedDocuments();
  }

  console.log('\n✓ Complete. Run again to confirm it is a no-op.');
  await disconnectFromDatabase();
}

// Only run when invoked directly, so a test can import `run()` without side effects.
if (process.argv[1]?.includes('2026-08-01-storage-provider-fields')) {
  main().catch(async (error: unknown) => {
    console.error('✗ Migration failed');
    console.error(error instanceof Error ? error.message : error);
    await disconnectFromDatabase().catch(() => undefined);
    process.exit(1);
  });
}
