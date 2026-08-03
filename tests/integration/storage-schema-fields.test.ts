/**
 * Phase 3 — the storage fields, against a real MongoDB.
 *
 * Everything here needs a genuine database rather than a mock, because every guarantee
 * being asserted is enforced *by MongoDB*, not by application code: what a partial unique
 * index rejects, whether a default materializes on a document that predates the field,
 * whether the migration script is genuinely a no-op on a second run. A mock would be
 * asserting my own assumptions back at me.
 *
 * The most important test in this file is the last one in "version immutability": the hook
 * was widened in Phase 3, and the thing it exists to protect — that the bytes a reviewer
 * approved cannot be swapped underneath the approval — must still hold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose, { Types } from 'mongoose';

import { startTestDb, stopTestDb, clearCollections, type TestDb } from '../helpers/test-db';
import { FileVersionModel } from '@/server/db/models/file-version.model';
import { FolderModel } from '@/server/db/models/folder.model';
import { FileModel } from '@/server/db/models/file.model';
import { StorageMigrationItemModel } from '@/server/db/models/storage-migration-item.model';
import { StorageRecoveryItemModel } from '@/server/db/models/storage-recovery-item.model';
import { DriveSyncStateModel } from '@/server/db/models/drive-sync-state.model';

let db: TestDb;

function skipUnlessDb(): boolean {
  if (db.available) return false;
  expect(db.reason, 'in-memory MongoDB unavailable').toBeTruthy();
  return true;
}

const ORG = new Types.ObjectId();

/** A version document exactly as Phase 2 would have written it — no storage fields at all. */
async function insertLegacyVersion(overrides: Record<string, unknown> = {}): Promise<Types.ObjectId> {
  const id = new Types.ObjectId();
  // Inserted through the driver, bypassing Mongoose, so the new paths are genuinely absent
  // from the stored document rather than written with their defaults.
  await mongoose.connection.collection('fileversions').insertOne({
    _id: id,
    organizationId: ORG,
    fileId: new Types.ObjectId(),
    versionNumber: 1,
    storageKey: `originals/legacy/${id.toHexString()}`,
    storageArea: 'originals',
    originalFilename: 'legacy.csv',
    fileSize: 128,
    mimeType: 'text/csv',
    extension: 'csv',
    checksumSha256: 'a'.repeat(64),
    uploadedBy: new Types.ObjectId(),
    uploadedAt: new Date('2026-07-01'),
    processingStatus: 'ready',
    label: 'draft',
    isCurrent: true,
    isApproved: false,
    createdAt: new Date('2026-07-01'),
    updatedAt: new Date('2026-07-01'),
    __v: 0,
    ...overrides,
  });
  return id;
}

beforeAll(async () => {
  db = await startTestDb();
}, 180_000);

afterAll(async () => {
  if (db?.available) await stopTestDb();
});

beforeEach(async () => {
  if (db.available) await clearCollections();
});

describe('existing documents keep working with no backfill', () => {
  /**
   * The whole reason Phase 3 can ship without a write lock on a large collection: Mongoose
   * applies a schema default on *read* for a path absent from the stored document. If this
   * ever stopped being true, every pre-migration version would resolve to an undefined
   * provider and the registry would refuse to read it.
   */
  it('materializes storage defaults on a version written before the fields existed', async () => {
    if (skipUnlessDb()) return;
    const id = await insertLegacyVersion();

    const version = await FileVersionModel.findById(id);

    expect(version).not.toBeNull();
    expect(version!.storageProvider).toBe('local');
    expect(version!.migrationStatus).toBe('not_started');
    expect(version!.syncStatus).toBe('not_required');
    expect(version!.localCopyState).toBe('present');
    expect(version!.isGoogleNative).toBe(false);
    expect(version!.googleDriveFileId).toBeNull();
  });

  /** The stored document is genuinely untouched — reading it did not rewrite it. */
  it('does not write the defaults back to disk on read', async () => {
    if (skipUnlessDb()) return;
    const id = await insertLegacyVersion();
    await FileVersionModel.findById(id);

    const raw = await mongoose.connection.collection('fileversions').findOne({ _id: id });
    expect(raw).not.toBeNull();
    expect('storageProvider' in raw!).toBe(false);
    expect('migrationStatus' in raw!).toBe(false);
  });

  /**
   * The content-identity fields are what a download and an approval depend on. Adding
   * columns beside them must not disturb them.
   */
  it('leaves the fields a download depends on intact', async () => {
    if (skipUnlessDb()) return;
    const id = await insertLegacyVersion();

    const version = await FileVersionModel.findById(id);

    expect(version!.storageKey).toBe(`originals/legacy/${id.toHexString()}`);
    expect(version!.storageArea).toBe('originals');
    expect(version!.checksumSha256).toBe('a'.repeat(64));
    expect(version!.fileSize).toBe(128);
  });

  it('applies folder and file defaults the same way', async () => {
    if (skipUnlessDb()) return;
    const folderId = new Types.ObjectId();
    await mongoose.connection.collection('folders').insertOne({
      _id: folderId,
      organizationId: ORG,
      name: 'Legacy',
      nameLower: 'legacy',
      parentFolderId: null,
      pathAncestors: [],
      depth: 0,
      driveType: 'my',
      ownerId: new Types.ObjectId(),
      createdBy: new Types.ObjectId(),
      deletedAt: null,
      createdAt: new Date('2026-07-01'),
      updatedAt: new Date('2026-07-01'),
      __v: 0,
    });

    const folder = await FolderModel.findById(folderId);
    expect(folder!.storageProvider).toBe('local');
    expect(folder!.driveMappingStatus).toBe('none');
    expect(folder!.googleDriveFolderId).toBeNull();
  });
});

describe('version immutability after the Phase 3 widening', () => {
  /**
   * The migration must be able to record where the bytes now also live. Before Phase 3 this
   * threw, and it was invisible until the first write failed mid-migration.
   */
  it('permits recording a storage location', async () => {
    if (skipUnlessDb()) return;
    const id = await insertLegacyVersion();

    await expect(
      FileVersionModel.updateOne(
        { _id: id },
        {
          $set: {
            storageProvider: 'google_drive',
            googleDriveFileId: 'drive-abc',
            googleDriveRevisionId: 'rev-1',
            googleDriveMd5: 'b'.repeat(32),
            migrationStatus: 'verified',
            migratedAt: new Date(),
            localCopyEligibleForDeletionAt: new Date(),
          },
        },
      ),
    ).resolves.toBeTruthy();

    const version = await FileVersionModel.findById(id);
    expect(version!.storageProvider).toBe('google_drive');
    expect(version!.migrationStatus).toBe('verified');
  });

  it('permits the sync and local-copy lifecycle fields', async () => {
    if (skipUnlessDb()) return;
    const id = await insertLegacyVersion();

    await expect(
      FileVersionModel.updateOne(
        { _id: id },
        { $set: { syncStatus: 'conflict', lastSyncedAt: new Date(), localCopyState: 'archived' } },
      ),
    ).resolves.toBeTruthy();
  });

  /**
   * ★ The one that matters. A migration that could rewrite a checksum could hide a corrupt
   * transfer by recording the corruption as expected — which would defeat every verification
   * guarantee in the phase plan, and would do so silently.
   */
  it('still refuses to rewrite the identity of the approved bytes', async () => {
    if (skipUnlessDb()) return;
    const id = await insertLegacyVersion();

    for (const forbidden of [
      { checksumSha256: 'c'.repeat(64) },
      { fileSize: 999 },
      { storageKey: 'originals/somewhere/else' },
      { versionNumber: 7 },
      { originalFilename: 'different.csv' },
      { mimeType: 'application/pdf' },
      { extension: 'pdf' },
      { fileId: new Types.ObjectId() },
    ]) {
      await expect(
        FileVersionModel.updateOne({ _id: id }, { $set: forbidden }),
        `${Object.keys(forbidden)[0]} must remain immutable`,
      ).rejects.toThrow(/immutable/i);
    }

    // And nothing got through.
    const version = await FileVersionModel.findById(id);
    expect(version!.checksumSha256).toBe('a'.repeat(64));
    expect(version!.fileSize).toBe(128);
  });

  it('still refuses a whole-document replacement', async () => {
    if (skipUnlessDb()) return;
    const id = await insertLegacyVersion();

    await expect(
      FileVersionModel.updateOne({ _id: id }, { checksumSha256: 'd'.repeat(64) } as never),
    ).rejects.toThrow(/immutable/i);
  });
});

describe('indexes enforce the guarantees rather than the code promising them', () => {
  /**
   * The hard guarantee against duplicate uploads on retry. It has to be the database: the
   * worker's own bookkeeping is by definition unavailable at the moment the worker crashes.
   */
  it('refuses two versions claiming the same Drive file', async () => {
    if (skipUnlessDb()) return;
    const first = await insertLegacyVersion();
    const second = await insertLegacyVersion();

    await FileVersionModel.updateOne({ _id: first }, { $set: { googleDriveFileId: 'drive-dup' } });

    await expect(
      FileVersionModel.updateOne({ _id: second }, { $set: { googleDriveFileId: 'drive-dup' } }),
    ).rejects.toThrow(/duplicate key/i);
  });

  /**
   * ...while leaving every unmigrated version alone. A non-partial unique index would treat
   * all those nulls as colliding and reject the second document ever written.
   */
  it('allows any number of versions with no Drive file', async () => {
    if (skipUnlessDb()) return;
    await insertLegacyVersion();
    await insertLegacyVersion();
    await insertLegacyVersion();

    expect(await FileVersionModel.countDocuments({})).toBe(3);
  });

  it('refuses two folders mapped to the same Drive folder', async () => {
    if (skipUnlessDb()) return;
    const base = {
      organizationId: ORG,
      nameLower: 'x',
      driveType: 'my' as const,
      ownerId: new Types.ObjectId(),
      createdBy: new Types.ObjectId(),
      parentFolderId: new Types.ObjectId(),
    };

    await FolderModel.create({ ...base, name: 'A', nameLower: 'a', googleDriveFolderId: 'gd-1' });
    await expect(
      FolderModel.create({ ...base, name: 'B', nameLower: 'b', googleDriveFolderId: 'gd-1' }),
    ).rejects.toThrow(/duplicate key/i);
  });

  /**
   * Two overlapping migration jobs must not both transfer the same version: only one can
   * win the unique index on `googleDriveFileId`, and the loser leaves an orphan in company
   * storage that no record points at.
   */
  it('refuses a second active claim on one version', async () => {
    if (skipUnlessDb()) return;
    const versionId = new Types.ObjectId();
    const base = {
      organizationId: ORG,
      versionId,
      fileId: new Types.ObjectId(),
      folderId: new Types.ObjectId(),
    };

    await StorageMigrationItemModel.create({
      ...base,
      jobId: new Types.ObjectId(),
      idempotencyKey: 'job-a:v1',
      status: 'uploading',
      claimActive: true,
    });

    await expect(
      StorageMigrationItemModel.create({
        ...base,
        jobId: new Types.ObjectId(),
        idempotencyKey: 'job-b:v1',
        status: 'uploading',
        claimActive: true,
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  /** But two jobs may both have *planned* the same version — only transfer is exclusive. */
  it('allows several jobs to hold an unclaimed item for one version', async () => {
    if (skipUnlessDb()) return;
    const versionId = new Types.ObjectId();
    const base = {
      organizationId: ORG,
      versionId,
      fileId: new Types.ObjectId(),
      folderId: new Types.ObjectId(),
      status: 'not_started' as const,
      claimActive: false,
    };

    await StorageMigrationItemModel.create({ ...base, jobId: new Types.ObjectId(), idempotencyKey: 'a' });
    await StorageMigrationItemModel.create({ ...base, jobId: new Types.ObjectId(), idempotencyKey: 'b' });

    expect(await StorageMigrationItemModel.countDocuments({ versionId })).toBe(2);
  });

  it('refuses the same item twice within one job', async () => {
    if (skipUnlessDb()) return;
    const jobId = new Types.ObjectId();
    const versionId = new Types.ObjectId();
    const base = {
      organizationId: ORG,
      jobId,
      versionId,
      fileId: new Types.ObjectId(),
      folderId: new Types.ObjectId(),
    };

    await StorageMigrationItemModel.create({ ...base, idempotencyKey: 'k1' });
    await expect(
      StorageMigrationItemModel.create({ ...base, idempotencyKey: 'k2' }),
    ).rejects.toThrow(/duplicate key/i);
  });

  /**
   * One open recovery row per logical operation. A retry re-entering the same code path
   * must find the existing row rather than opening a second and racing itself.
   */
  it('refuses two open recovery items for one idempotency key', async () => {
    if (skipUnlessDb()) return;
    const base = { organizationId: ORG, phase: 'drive_write_pending' as const, idempotencyKey: 'op-1' };

    await StorageRecoveryItemModel.create(base);
    await expect(StorageRecoveryItemModel.create(base)).rejects.toThrow(/duplicate key/i);

    // Once resolved it no longer occupies the key, so the same operation can recur later.
    await StorageRecoveryItemModel.updateOne(
      { idempotencyKey: 'op-1' },
      { $set: { status: 'resolved_adopted', resolvedAt: new Date() } },
    );
    await expect(StorageRecoveryItemModel.create(base)).resolves.toBeTruthy();
  });

  /** Two cursors for one drive would each replay changes the other had already applied. */
  it('refuses a second sync cursor for the same Shared Drive', async () => {
    if (skipUnlessDb()) return;
    const base = { organizationId: ORG, sharedDriveId: '0ADrive' };

    await DriveSyncStateModel.create(base);
    await expect(DriveSyncStateModel.create(base)).rejects.toThrow(/duplicate key/i);
  });
});

describe('the File mirror carries a category, never an address', () => {
  /**
   * `File` has never held a storage location, so a physical path cannot leak through a file
   * listing however carelessly it is serialized. Phase 3 must not have quietly broken that.
   */
  it('has no Drive identifier field at all', () => {
    const paths = Object.keys(FileModel.schema.paths);
    expect(paths.filter((p) => /googleDrive|storageKey|storageArea/i.test(p))).toEqual([]);
  });

  it('accepts the mixed state a part-migrated file really is in', async () => {
    if (skipUnlessDb()) return;
    const file = await FileModel.create({
      organizationId: ORG,
      displayName: 'partial.csv',
      displayNameLower: 'partial.csv',
      originalFilename: 'partial.csv',
      extension: 'csv',
      folderId: new Types.ObjectId(),
      driveType: 'my',
      ownerId: new Types.ObjectId(),
      createdBy: new Types.ObjectId(),
      storageProvider: 'mixed',
    });

    expect(file.storageProvider).toBe('mixed');
  });

  it('defaults to local', async () => {
    if (skipUnlessDb()) return;
    const file = await FileModel.create({
      organizationId: ORG,
      displayName: 'a.csv',
      displayNameLower: 'a.csv',
      originalFilename: 'a.csv',
      extension: 'csv',
      folderId: new Types.ObjectId(),
      driveType: 'my',
      ownerId: new Types.ObjectId(),
      createdBy: new Types.ObjectId(),
    });

    expect(file.storageProvider).toBe('local');
    expect(file.hasGoogleNativeContent).toBe(false);
  });
});

describe('the migration script', () => {
  /**
   * Run twice in CI, which is the acceptance criterion: a deploy that re-runs it — or two
   * application instances rolling at once — must not fight over index builds.
   */
  it('is a no-op on a second run', async () => {
    if (skipUnlessDb()) return;
    const { run } = await import('../../scripts/db/2026-08-01-storage-provider-fields');

    const first = await run();
    const second = await run();

    expect(second.created).toEqual([]);
    expect(second.alreadyPresent).toBeGreaterThanOrEqual(first.alreadyPresent);
  });
});
