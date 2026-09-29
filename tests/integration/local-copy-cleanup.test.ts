/**
 * Phase 11 — the only irreversible step in the migration.
 *
 * Every migrated version keeps its local bytes, and that retention is not caution for its own
 * sake: it *is* the rollback mechanism (reverting is a field flip with no data movement, which
 * only works while the bytes are there) and it is Phase 4's fallback when a Drive object goes
 * missing. Removing them ends both guarantees at once.
 *
 * So the tests here are almost entirely about refusals, and about the difference between the
 * two actions:
 *
 *   • **Archive** moves the bytes aside. Nothing is lost, rollback still works, and the disk
 *     comes back. It is what an administrator should reach for.
 *   • **Delete** removes them, and is gated on a configuration flag, an explicit request, a
 *     passed retention window, a `verified` migration *and* a live check that the file really
 *     is in Drive at that moment — because `verified` was set by a job weeks ago and nobody
 *     has re-checked it since.
 */
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { actorFor, seedFixture, TEST_META, type Fixture } from '../helpers/fixtures';
import { FakeDriveClient } from '../helpers/fake-drive';
import type { Actor } from '@/server/permissions/actor';
import { GoogleDriveObjectStore } from '@/server/storage/google/google-drive-object-store';
import type { DriveStorageConfig } from '@/server/storage/google/drive-config';
import { AuditLogModel } from '@/server/db/models/audit-log.model';
import { FileVersionModel } from '@/server/db/models/file-version.model';
import { resetEnvCache } from '@/server/config/env';

let db: TestDb;
let fixture: Fixture;
let drive: FakeDriveClient;

const DRIVE_ROOT = 'root-folder';
const savedEnv = { ...process.env };

function skipUnlessDb(): boolean {
  if (db.available) return false;
  expect(db.reason, 'in-memory MongoDB unavailable').toBeTruthy();
  return true;
}

function driveConfig(): DriveStorageConfig {
  return {
    sharedDriveId: 'drive-company',
    rootFolderId: DRIVE_ROOT,
    serviceAccountEmail: 'sa@example.iam.gserviceaccount.com',
    privateKey: '-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----',
    workspaceDomain: null,
    uploadChunkBytes: 256 * 1024,
    maxConcurrentTransfers: 4,
    requestTimeoutMs: 30_000,
    keySource: 'file',
  };
}

function enableDrive(options: { allowDelete?: boolean } = {}): void {
  process.env.GOOGLE_DRIVE_STORAGE_ENABLED = 'true';
  process.env.DEFAULT_STORAGE_PROVIDER = 'google_drive';
  process.env.GOOGLE_SHARED_DRIVE_ID = 'drive-company';
  process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL = 'sa@example.iam.gserviceaccount.com';
  process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY =
    '-----BEGIN PRIVATE KEY-----\\nunused\\n-----END PRIVATE KEY-----';
  process.env.DELETE_LOCAL_AFTER_MIGRATION = options.allowDelete ? 'true' : 'false';
  resetEnvCache();
}

async function services() {
  return {
    uploadService: (await import('@/server/services/upload.service')).uploadService,
    folderService: (await import('@/server/services/folder.service')).folderService,
    driveService: (await import('@/server/services/drive.service')).driveService,
    localCopies: await import('@/server/services/storage-migration/local-copies'),
  };
}

async function makeFolder(actor: Actor, name: string): Promise<string> {
  const { driveService, folderService } = await services();
  const root = await driveService.getMyDriveRoot(actor);
  const folder = await folderService.createFolder(actor, { name, parentFolderId: root.id }, TEST_META);
  return folder.id;
}

/**
 * A migrated version whose retention window has already passed.
 *
 * The retention date is backdated rather than waited out — the property under test is what
 * happens *at* eligibility, and a test that could only run 30 days later would test nothing.
 */
async function migratedVersion(name: string, options: { eligible?: boolean } = {}) {
  const { uploadService } = await services();
  const alice = await actorFor(fixture.users.scientistA);
  const folder = await makeFolder(alice, `Cleanup ${name}`);
  const content = Buffer.from(`local bytes for ${name}`);

  const ticket = await uploadService.authorizeUpload(
    alice,
    { folderId: folder, filename: `${name}.csv`, size: content.byteLength },
    TEST_META,
  );
  await uploadService.receiveStream(alice, ticket.sessionId, Readable.from(content), TEST_META);
  const uploaded = await uploadService.finalize(alice, ticket.sessionId, TEST_META);

  const version = await FileVersionModel.findById(uploaded.versionId).lean();
  expect(version!.googleDriveFileId, 'the upload should have reached Drive').toBeTruthy();
  expect(version!.migrationStatus).toBe('verified');

  if (options.eligible !== false) {
    await FileVersionModel.updateOne(
      { _id: uploaded.versionId },
      { $set: { localCopyEligibleForDeletionAt: new Date(Date.now() - 86_400_000) } },
    );
  }

  return {
    fileId: uploaded.fileId,
    versionId: uploaded.versionId,
    driveFileId: version!.googleDriveFileId!,
    storageKey: version!.storageKey,
    storageArea: version!.storageArea,
  };
}

async function localExists(key: string, area: string): Promise<boolean> {
  const { getObjectStore } = await import('@/server/storage');
  return getObjectStore('local').exists({ provider: 'local', key, area: area as never });
}

beforeAll(async () => {
  db = await startTestDb();
  if (!db.available) return;
  fixture = await seedFixture();
  const { getStorageProvider } = await import('@/server/storage');
  await getStorageProvider().ensureReady();
}, 180_000);

afterAll(async () => {
  if (db?.available) await stopTestDb();
});

beforeEach(async () => {
  drive = new FakeDriveClient();
  if (!db.available) return;

  const store = new GoogleDriveObjectStore(drive, driveConfig());
  const { getObjectStore, storageRegistry } = await import('@/server/storage');
  getObjectStore('local');
  storageRegistry.register({ objects: store, hierarchy: store });

  const { setGoogleDriveStorage } = await import('@/server/storage/google');
  setGoogleDriveStorage({ client: drive, store });

  enableDrive();
});

afterEach(async () => {
  process.env = { ...savedEnv };
  resetEnvCache();
  const { setGoogleDriveStorage } = await import('@/server/storage/google');
  setGoogleDriveStorage(null);
});

describe('what is eligible', () => {
  it('leaves a copy alone until its retention window has passed', async () => {
    if (skipUnlessDb()) return;
    const { versionId } = await migratedVersion('within-retention', { eligible: false });
    const { localCopies } = await services();

    const result = await localCopies.sweepLocalCopies({ action: 'archive', dryRun: false });

    expect(result.eligible).toBe(0);
    expect((await FileVersionModel.findById(versionId).lean())!.localCopyState).toBe('present');
  });

  it('reports what it would do without touching anything', async () => {
    if (skipUnlessDb()) return;
    const { versionId, storageKey, storageArea } = await migratedVersion('dry-run');
    const { localCopies } = await services();

    const result = await localCopies.sweepLocalCopies({ action: 'archive', dryRun: true });

    expect(result.eligible).toBeGreaterThanOrEqual(1);
    expect(result.bytesReclaimed).toBeGreaterThan(0);
    expect(result.processed).toBe(0);
    expect(await localExists(storageKey, storageArea)).toBe(true);
    expect((await FileVersionModel.findById(versionId).lean())!.localCopyState).toBe('present');
  });

  it('counts what is being kept and what is now reclaimable', async () => {
    if (skipUnlessDb()) return;
    await migratedVersion('summary-kept', { eligible: false });
    await migratedVersion('summary-eligible');
    const { localCopies } = await services();

    const summary = await localCopies.summarizeLocalCopies();
    expect(summary.retained).toBeGreaterThanOrEqual(2);
    expect(summary.eligible).toBeGreaterThanOrEqual(1);
    expect(summary.eligibleBytes).toBeGreaterThan(0);
    expect(summary.retainedBytes).toBeGreaterThanOrEqual(summary.eligibleBytes);
  });
});

describe('archiving', () => {
  it('moves the bytes aside rather than destroying them', async () => {
    if (skipUnlessDb()) return;
    const { versionId, storageKey, storageArea } = await migratedVersion('archived');
    const { localCopies } = await services();

    const result = await localCopies.sweepLocalCopies({ action: 'archive', dryRun: false });
    expect(result.processed).toBeGreaterThanOrEqual(1);

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.localCopyState).toBe('archived');
    expect(version!.archivedStorageKey).toBeTruthy();
    expect(version!.localCopyArchivedAt).toBeTruthy();

    // Gone from where it was, present where it went. Nothing was destroyed.
    expect(await localExists(storageKey, storageArea)).toBe(false);
    expect(await localExists(version!.archivedStorageKey!, 'archives')).toBe(true);

    // And the identity fields are untouched: `storageKey` still records the address the
    // version was created at, which is what makes the archive mapping meaningful.
    expect(version!.storageKey).toBe(storageKey);
    expect(version!.storageArea).toBe(storageArea);
  });

  it('records who archived it', async () => {
    if (skipUnlessDb()) return;
    const { fileId } = await migratedVersion('archive-audited');
    const { localCopies } = await services();
    const admin = await actorFor(fixture.users.companyAdmin);

    await localCopies.sweepLocalCopies({
      action: 'archive',
      dryRun: false,
      audit: { actor: admin, meta: TEST_META },
    });

    const entry = await AuditLogModel.findOne({
      action: 'storage_migration.local_copy_archived',
      entityId: fileId,
    }).lean();
    expect(entry).toBeTruthy();
    expect(String(entry!.actorUserId)).toBe(fixture.users.companyAdmin);
  });

  it('is a no-op the second time', async () => {
    if (skipUnlessDb()) return;
    const { fileId } = await migratedVersion('archive-twice');
    const { localCopies } = await services();

    await localCopies.sweepLocalCopies({ action: 'archive', dryRun: false });
    const second = await localCopies.sweepLocalCopies({ action: 'archive', dryRun: false });

    // Already archived, so no longer a candidate at all — and no second audit entry.
    expect(second.processed).toBe(0);
    expect(
      await AuditLogModel.countDocuments({
        action: 'storage_migration.local_copy_archived',
        entityId: fileId,
      }),
    ).toBe(1);
  });

  it('still lets the file be downloaded afterwards', async () => {
    if (skipUnlessDb()) return;
    const { fileId } = await migratedVersion('archived-readable');
    const { localCopies } = await services();
    await localCopies.sweepLocalCopies({ action: 'archive', dryRun: false });

    // The bytes are served from Drive, which is the whole point of having migrated. Archiving
    // the local copy must not disturb that.
    const alice = await actorFor(fixture.users.scientistA);
    const { downloadService } = await import('@/server/services/download.service');
    const stream = await downloadService.download(alice, fileId, {}, TEST_META);
    expect(stream.totalSize).toBeGreaterThan(0);
  });
});

describe('deleting', () => {
  it('is refused unless the deployment has switched it on', async () => {
    if (skipUnlessDb()) return;
    await migratedVersion('delete-off');
    const { localCopies } = await services();

    await expect(
      localCopies.sweepLocalCopies({ action: 'delete', dryRun: false }),
    ).rejects.toThrow(/DELETE_LOCAL_AFTER_MIGRATION/);
  });

  it('removes the bytes when it is on, and records it', async () => {
    if (skipUnlessDb()) return;
    enableDrive({ allowDelete: true });
    const { fileId, versionId, storageKey, storageArea } = await migratedVersion('delete-on');
    const { localCopies } = await services();

    const result = await localCopies.sweepLocalCopies({ action: 'delete', dryRun: false });
    expect(result.processed).toBeGreaterThanOrEqual(1);

    expect(await localExists(storageKey, storageArea)).toBe(false);
    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.localCopyState).toBe('deleted');
    expect(version!.localCopyDeletedAt).toBeTruthy();

    const entry = await AuditLogModel.findOne({
      action: 'storage_migration.local_copy_deleted',
      entityId: fileId,
    }).lean();
    // Irreversible, so it is recorded at a severity that survives a filtered audit view.
    expect(entry!.severity).toBe('warning');
  });

  /**
   * The single most important refusal in this file. `migrationStatus: 'verified'` was true
   * when a job said so, possibly weeks ago. If somebody has since emptied the Shared Drive
   * trash, deleting the only other copy on the strength of that stale flag is exactly the
   * data-loss event the whole retention design exists to prevent.
   */
  it('refuses when the file is no longer actually in Drive', async () => {
    if (skipUnlessDb()) return;
    enableDrive({ allowDelete: true });
    const { versionId, driveFileId, storageKey, storageArea } = await migratedVersion('vanished');
    const { localCopies } = await services();

    await drive.deleteFile(driveFileId);

    const result = await localCopies.sweepLocalCopies({ action: 'delete', dryRun: false });

    // Other eligible versions left over from earlier tests may well be processed in the same
    // sweep — one bad file must not abandon the run. What matters is that *this* one was not.
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(Object.keys(result.skippedReasons).join(' ')).toContain('no longer in the Shared Drive');

    // The local copy — now the *only* copy — is untouched.
    expect(await localExists(storageKey, storageArea)).toBe(true);
    expect((await FileVersionModel.findById(versionId).lean())!.localCopyState).toBe('present');
  });

  it('can delete an already-archived copy from where it was archived to', async () => {
    if (skipUnlessDb()) return;
    enableDrive({ allowDelete: true });
    const { versionId } = await migratedVersion('archive-then-delete');
    const { localCopies } = await services();

    await localCopies.sweepLocalCopies({ action: 'archive', dryRun: false });
    const archived = await FileVersionModel.findById(versionId).lean();
    expect(await localExists(archived!.archivedStorageKey!, 'archives')).toBe(true);

    await localCopies.sweepLocalCopies({ action: 'delete', dryRun: false });

    expect(await localExists(archived!.archivedStorageKey!, 'archives')).toBe(false);
    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.localCopyState).toBe('deleted');
    expect(version!.archivedStorageKey).toBeNull();
  });
});

describe('rollback after cleanup', () => {
  /**
   * Archiving must not cost the rollback guarantee — that is the entire reason archive and
   * delete are two actions rather than one with a flag.
   */
  it('restores an archived copy back to its original address', async () => {
    if (skipUnlessDb()) return;
    const { versionId, storageKey, storageArea } = await migratedVersion('rollback-archived');
    const { localCopies } = await services();
    await localCopies.sweepLocalCopies({ action: 'archive', dryRun: false });
    expect(await localExists(storageKey, storageArea)).toBe(false);

    // The rollback path reads a migration job's verified items, so this exercises the
    // restore step directly rather than through a job that this test would have to fabricate.
    const { getObjectStore } = await import('@/server/storage');
    const archived = await FileVersionModel.findById(versionId).lean();
    await getObjectStore('local').copy(
      { provider: 'local', key: archived!.archivedStorageKey!, area: 'archives' },
      { key: storageKey, area: storageArea as never },
    );

    expect(await localExists(storageKey, storageArea)).toBe(true);
  });

  it('a deleted copy has nothing to roll back to, and the record says so', async () => {
    if (skipUnlessDb()) return;
    enableDrive({ allowDelete: true });
    const { versionId } = await migratedVersion('rollback-deleted');
    const { localCopies } = await services();
    await localCopies.sweepLocalCopies({ action: 'delete', dryRun: false });

    // `deleted` is what the rollback runner checks before refusing. Recording it truthfully
    // is what turns a potential data-loss event into a skipped item and a clear report.
    expect((await FileVersionModel.findById(versionId).lean())!.localCopyState).toBe('deleted');
  });
});
