/**
 * Phase 9 — hearing about changes made directly in the Shared Drive.
 *
 * The claims under test divide into two groups, and the second group is the one that would
 * survive a careless refactor while being catastrophically wrong.
 *
 * **What synchronization does.** A document edited in Drive updates here and, if it was
 * approved, goes back to review. A rename is adopted. Trash and restore mirror. A file
 * removed from Drive is marked missing.
 *
 * **What it refuses to do, and what it never mistakes for success.**
 *
 *   • A file *moved* in Drive is not moved here. In this application a file's folder is its
 *     permission chain and its quota owner; applying that on the authority of a Drive event
 *     would let somebody outside the permission model silently re-share research data.
 *   • A removal never deletes a record (§16).
 *   • An **expired cursor is not an empty page**. Drive answers a stale token with 404, and
 *     reading that as "nothing changed" would silently desynchronise everything, permanently
 *     and invisibly. It has to force a reconcile.
 *   • Replaying a page changes nothing, because the cursor advances only after a page is
 *     applied and a crash in between replays it.
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
import { FileModel } from '@/server/db/models/file.model';
import { FileVersionModel } from '@/server/db/models/file-version.model';
import { FolderModel } from '@/server/db/models/folder.model';
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

function enableDrive(): void {
  process.env.GOOGLE_DRIVE_STORAGE_ENABLED = 'true';
  process.env.DEFAULT_STORAGE_PROVIDER = 'google_drive';
  process.env.GOOGLE_SHARED_DRIVE_ID = 'drive-company';
  process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL = 'sa@example.iam.gserviceaccount.com';
  process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY =
    '-----BEGIN PRIVATE KEY-----\\nunused\\n-----END PRIVATE KEY-----';
  resetEnvCache();
}

async function services() {
  return {
    uploadService: (await import('@/server/services/upload.service')).uploadService,
    folderService: (await import('@/server/services/folder.service')).folderService,
    driveService: (await import('@/server/services/drive.service')).driveService,
    reviewService: (await import('@/server/services/review.service')).reviewService,
    sync: await import('@/server/services/drive-sync.service'),
  };
}

async function makeFolder(actor: Actor, name: string): Promise<string> {
  const { driveService, folderService } = await services();
  const root = await driveService.getDepartmentRoot(actor, fixture.departments.molbio);
  const folder = await folderService.createFolder(actor, { name, parentFolderId: root.id }, TEST_META);
  return folder.id;
}

async function upload(actor: Actor, folderId: string, filename: string, content: Buffer) {
  const { uploadService } = await services();
  const ticket = await uploadService.authorizeUpload(
    actor,
    { folderId, filename, size: content.byteLength },
    TEST_META,
  );
  await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(content));
  return uploadService.finalize(actor, ticket.sessionId, TEST_META);
}

/** A file in Drive, plus the cursor established afterwards so only later events are in play. */
async function fileInDrive(name: string): Promise<{
  fileId: string;
  versionId: string;
  driveFileId: string;
  folderId: string;
}> {
  const alice = await actorFor(fixture.users.scientistA);
  const folder = await makeFolder(alice, `Sync ${name}`);
  const uploaded = await upload(alice, folder, `${name}.csv`, Buffer.from(`content of ${name}`));

  const version = await FileVersionModel.findById(uploaded.versionId).lean();
  expect(version!.googleDriveFileId, 'the upload should have reached Drive').toBeTruthy();

  // The baseline run: takes a cursor, applies nothing. Everything a test does after this is
  // what the next run sees.
  const { sync } = await services();
  const first = await sync.syncDriveChanges({ organizationId: fixture.organizationId });
  expect(first.initialized).toBe(true);

  return {
    fileId: uploaded.fileId,
    versionId: uploaded.versionId,
    driveFileId: version!.googleDriveFileId!,
    folderId: folder,
  };
}

async function runSync() {
  const { sync } = await services();
  return sync.syncDriveChanges({ organizationId: fixture.organizationId });
}

beforeAll(async () => {
  db = await startTestDb();
  if (!db.available) return;
  fixture = await seedFixture();
  const { getStorageProvider } = await import('@/server/storage');
  await getStorageProvider().ensureReady();

  const roleRepository = await import('@/server/repositories/role.repository');
  await roleRepository.grantRole({
    organizationId: fixture.organizationId,
    userId: fixture.users.scientistB,
    roleId: fixture.roleIds.rd_head!,
    scopeType: 'department',
    scopeId: fixture.departments.molbio,
    grantedBy: fixture.users.superAdmin,
  });
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

  // Each test starts from a clean cursor, so one test's changes are never another's feed.
  const { DriveSyncStateModel } = await import('@/server/db/models/drive-sync-state.model');
  await DriveSyncStateModel.deleteMany({}).exec();
});

afterEach(async () => {
  process.env = { ...savedEnv };
  resetEnvCache();
  const { setGoogleDriveStorage } = await import('@/server/storage/google');
  setGoogleDriveStorage(null);
});

describe('establishing the cursor', () => {
  it('applies nothing on the first run, and says so', async () => {
    if (skipUnlessDb()) return;
    const alice = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(alice, 'Baseline');
    await upload(alice, folder, 'before.csv', Buffer.from('x'));

    const first = await runSync();

    // The upload above is *not* replayed as a change. There is deliberately no attempt to
    // catch up on what happened before synchronization was switched on.
    expect(first.initialized).toBe(true);
    expect(first.changes).toBe(0);
  });

  it('does nothing at all on a deployment without Drive', async () => {
    if (skipUnlessDb()) return;
    process.env.GOOGLE_DRIVE_STORAGE_ENABLED = 'false';
    process.env.DEFAULT_STORAGE_PROVIDER = 'local';
    resetEnvCache();

    const summary = await runSync();
    expect(summary.ran).toBe(false);
    expect(drive.calls).not.toContain('listChanges');
  });
});

describe('what synchronization adopts', () => {
  it('notices a document edited in Drive and records the new revision', async () => {
    if (skipUnlessDb()) return;
    const { versionId, driveFileId } = await fileInDrive('edited');

    const before = await FileVersionModel.findById(versionId).lean();
    drive.editInDrive(driveFileId, Buffer.from('rewritten in the Drive web UI'));

    const summary = await runSync();
    expect(summary.contentUpdated).toBe(1);

    const after = await FileVersionModel.findById(versionId).lean();
    expect(after!.googleDriveRevisionId).not.toBe(before!.googleDriveRevisionId);
    expect(after!.lastSyncedAt).toBeTruthy();
  });

  it('adopts a rename, because a name is a label', async () => {
    if (skipUnlessDb()) return;
    const { fileId, driveFileId } = await fileInDrive('renamed');

    drive.renameInDrive(driveFileId, 'renamed-by-someone-else.csv');
    const summary = await runSync();

    expect(summary.renamed).toBe(1);
    expect((await FileModel.findById(fileId).lean())!.displayName).toBe(
      'renamed-by-someone-else.csv',
    );
  });

  it('mirrors Drive’s trash and restore into ours', async () => {
    if (skipUnlessDb()) return;
    const { fileId, driveFileId } = await fileInDrive('trashed');

    drive.trashInDrive(driveFileId);
    expect((await runSync()).trashed).toBe(1);

    const trashed = await FileModel.findById(fileId).setOptions({ withDeleted: true }).lean();
    expect(trashed!.deletedAt).toBeTruthy();
    // Nobody here did it, so nobody here is named. A false attribution in the one field that
    // answers "who deleted this?" would be worse than an empty one.
    expect(trashed!.deletedBy).toBeNull();

    drive.trashInDrive(driveFileId, false);
    expect((await runSync()).restored).toBe(1);
    expect((await FileModel.findById(fileId).lean())!.deletedAt).toBeNull();
  });

  it('sends an approved document that changed in Drive straight back to review', async () => {
    if (skipUnlessDb()) return;
    const { reviewService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folder = await makeFolder(alice, 'Sync approved');
    const uploaded = await upload(alice, folder, 'approved.csv', Buffer.from('signed off'));

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [fixture.users.scientistB] },
      TEST_META,
    );
    await reviewService.decide(bob, review.id, { decision: 'approve' }, TEST_META);

    const { sync } = await services();
    await sync.syncDriveChanges({ organizationId: fixture.organizationId });

    const version = await FileVersionModel.findById(uploaded.versionId).lean();
    drive.editInDrive(version!.googleDriveFileId!, Buffer.from('changed after approval'));

    // Not left for the nightly sweep: the feed has just said exactly which file it is.
    const summary = await runSync();
    expect(summary.approvalsReturnedToReview).toBe(1);

    const file = await FileModel.findById(uploaded.fileId).lean();
    expect(file!.approvalStatus).toBe('none');
    expect(file!.reviewStatus).toBe('changes_requested');
  });
});

describe('what synchronization refuses to do', () => {
  /**
   * The most consequential refusal in this phase. A file's folder is its permission chain
   * and its quota owner, so applying a Drive move would let somebody outside this
   * application's permission model — possibly with no account here at all — silently change
   * who can read a research file.
   */
  it('does not move a file that was moved in Drive; it reports it', async () => {
    if (skipUnlessDb()) return;
    const { fileId, versionId, folderId, driveFileId } = await fileInDrive('moved');

    const elsewhere = drive.seedFolder({ name: 'Somewhere else', parentId: DRIVE_ROOT });
    drive.moveInDrive(driveFileId, elsewhere.id);

    const summary = await runSync();
    expect(summary.conflicts).toBeGreaterThanOrEqual(1);

    // Unmoved here, and the disagreement is on the record.
    expect(String((await FileModel.findById(fileId).lean())!.folderId)).toBe(folderId);
    expect((await FileVersionModel.findById(versionId).lean())!.syncStatus).toBe('conflict');

    const entry = await AuditLogModel.findOne({
      action: 'drive_storage.sync_conflict',
      entityId: fileId,
    }).lean();
    expect(entry).toBeTruthy();
    expect(entry!.severity).toBe('warning');
  });

  it('does not trash a whole folder because Drive did', async () => {
    if (skipUnlessDb()) return;
    const { folderId } = await fileInDrive('folder-trash');

    const folder = await FolderModel.findById(folderId).lean();
    expect(folder!.googleDriveFolderId, 'the folder should be mirrored by now').toBeTruthy();

    drive.trashInDrive(folder!.googleDriveFolderId!);
    const summary = await runSync();

    expect(summary.conflicts).toBeGreaterThanOrEqual(1);
    // Trashing here would carry the whole subtree and everyone's access to it.
    const after = await FolderModel.findById(folderId).setOptions({ withDeleted: true }).lean();
    expect(after!.deletedAt).toBeNull();
    expect(after!.syncStatus).toBe('conflict');
  });

  /** §16, explicitly: a vanished Drive object never removes a record. */
  it('marks a removed file as missing and keeps every record it has', async () => {
    if (skipUnlessDb()) return;
    const { fileId, versionId, driveFileId } = await fileInDrive('removed');

    drive.removeInDrive(driveFileId);
    const summary = await runSync();

    expect(summary.missing).toBe(1);

    const file = await FileModel.findById(fileId).setOptions({ withDeleted: true }).lean();
    expect(file, 'the file record must survive').toBeTruthy();
    expect(file!.deletedAt).toBeNull();

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.syncStatus).toBe('conflict');

    const entry = await AuditLogModel.findOne({
      action: 'drive_storage.file_missing',
      entityId: fileId,
    }).lean();
    expect(entry!.severity).toBe('critical');
  });

  it('ignores objects it does not manage', async () => {
    if (skipUnlessDb()) return;
    await fileInDrive('unmanaged-baseline');

    // Somebody else's file, in the same Shared Drive. Not ours to act on.
    drive.seedFile({ name: 'someone-elses.xlsx', parentId: DRIVE_ROOT, content: Buffer.from('x') });

    const summary = await runSync();
    expect(summary.unmanaged).toBeGreaterThanOrEqual(1);
    expect(summary.conflicts).toBe(0);
    expect(summary.renamed).toBe(0);
  });
});

describe('the cursor', () => {
  it('advances, so the next run does not replay what it already applied', async () => {
    if (skipUnlessDb()) return;
    const { driveFileId } = await fileInDrive('advancing');

    drive.renameInDrive(driveFileId, 'first-rename.csv');
    expect((await runSync()).renamed).toBe(1);

    // Nothing new happened. The second run must see an empty feed, not the same rename.
    const second = await runSync();
    expect(second.changes).toBe(0);
    expect(second.renamed).toBe(0);
  });

  it('is idempotent when a page is replayed', async () => {
    if (skipUnlessDb()) return;
    const { fileId, driveFileId } = await fileInDrive('replayed');

    drive.renameInDrive(driveFileId, 'renamed-once.csv');
    await runSync();

    // Wind the cursor back by hand — exactly the state a crash between "applied" and
    // "advanced" leaves behind.
    const { DriveSyncStateModel } = await import('@/server/db/models/drive-sync-state.model');
    const state = await DriveSyncStateModel.findOne({}).lean();
    const rewound = String(Math.max(1, Number(state!.startPageToken) - 1));
    await DriveSyncStateModel.updateOne({ _id: state!._id }, { $set: { startPageToken: rewound } });

    const replay = await runSync();
    expect(replay.changes).toBeGreaterThanOrEqual(1);
    // Applied again, and nothing moved: same name, and no second audit entry.
    expect(replay.renamed).toBe(0);
    expect((await FileModel.findById(fileId).lean())!.displayName).toBe('renamed-once.csv');
    expect(await AuditLogModel.countDocuments({ action: 'file.rename', entityId: fileId })).toBe(1);
  });

  /**
   * The single worst failure available in this phase, and the reason `tokenExpiredAt` exists.
   * Drive answers a stale cursor with 404. An implementation that let that fall through to
   * "no changes" would poll cleanly forever while the two systems drifted apart.
   */
  it('treats an expired cursor as a demand for a full reconcile, not as an empty page', async () => {
    if (skipUnlessDb()) return;
    const { fileId, versionId, driveFileId } = await fileInDrive('expired');

    // While nobody was looking: the document was edited *and* the cursor expired.
    drive.editInDrive(driveFileId, Buffer.from('changed during the gap'));
    drive.expireChangeTokens();

    const summary = await runSync();

    expect(summary.reconciled).toBe(true);
    expect(summary.reconcileChecked).toBeGreaterThanOrEqual(1);
    // The change that happened during the gap is still found — by re-reading, not by the feed.
    expect(summary.contentUpdated).toBeGreaterThanOrEqual(1);

    const { DriveSyncStateModel } = await import('@/server/db/models/drive-sync-state.model');
    const state = await DriveSyncStateModel.findOne({}).lean();
    expect(state!.lastFullReconcileAt).toBeTruthy();
    // A fresh cursor was taken, and the expiry marker cleared once it was.
    expect(state!.tokenExpiredAt).toBeNull();
    expect(state!.startPageToken).toBeTruthy();

    const conflict = await AuditLogModel.findOne({ action: 'drive_storage.sync_conflict' })
      .sort({ createdAt: -1 })
      .lean();
    expect(conflict!.reason).toContain('expired');

    expect(fileId).toBeTruthy();
    expect(versionId).toBeTruthy();
  });

  it('finds a file that vanished during the gap, when reconciling', async () => {
    if (skipUnlessDb()) return;
    const { versionId, driveFileId } = await fileInDrive('vanished-in-gap');

    drive.removeInDrive(driveFileId);
    drive.expireChangeTokens();

    const summary = await runSync();
    expect(summary.reconciled).toBe(true);
    expect(summary.missing).toBeGreaterThanOrEqual(1);
    expect((await FileVersionModel.findById(versionId).lean())!.syncStatus).toBe('conflict');
  });

  it('records a failed run without advancing the cursor', async () => {
    if (skipUnlessDb()) return;
    await fileInDrive('failing');

    const { DriveSyncStateModel } = await import('@/server/db/models/drive-sync-state.model');
    const before = await DriveSyncStateModel.findOne({}).lean();

    const { DriveApiError } = await import('@/server/storage/google/drive-errors');
    drive.failNext(
      'listChanges',
      new DriveApiError({ status: 500, message: 'Internal Error', reason: 'backendError' }),
    );

    const summary = await runSync();
    expect(summary.error).toBeTruthy();

    const after = await DriveSyncStateModel.findOne({}).lean();
    expect(after!.state).toBe('failed');
    expect(after!.consecutiveFailures).toBe(1);
    // Nothing is lost: the cursor is where it was, so the next run re-reads the same page.
    expect(after!.startPageToken).toBe(before!.startPageToken);
  });
});
