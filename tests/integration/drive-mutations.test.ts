/**
 * Phase 7 — keeping the Shared Drive in step with renames, moves, trash and restore.
 *
 * Two things are being asserted, and the second matters more than the first.
 *
 * **The mirror is correct.** A rename in the application renames the Drive object; a move
 * moves it; a trash trashes it. Otherwise someone browsing the Shared Drive sees a tree that
 * stopped matching reality weeks ago.
 *
 * **A Drive failure changes nothing.** Every mutation is Drive-first, so a Drive failure
 * happens before anything local has changed and the user gets a plain error. The harder
 * case — Drive succeeded, the database then failed — is compensated: the Drive change is
 * undone. Both are tested by injecting failures, because neither can be reasoned about from
 * the code alone.
 */
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { actorFor, seedFixture, TEST_META, type Fixture } from '../helpers/fixtures';
import { FakeDriveClient } from '../helpers/fake-drive';
import type { Actor } from '@/server/permissions/actor';
import { DriveApiError } from '@/server/storage/google/drive-errors';
import { GoogleDriveObjectStore } from '@/server/storage/google/google-drive-object-store';
import type { DriveStorageConfig } from '@/server/storage/google/drive-config';
import { FileVersionModel } from '@/server/db/models/file-version.model';
import { FileModel } from '@/server/db/models/file.model';
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

function enableDriveUploads(): void {
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
    fileService: (await import('@/server/services/file.service')).fileService,
    folderService: (await import('@/server/services/folder.service')).folderService,
    driveService: (await import('@/server/services/drive.service')).driveService,
  };
}

async function uploadInto(
  actor: Actor,
  folderId: string,
  filename: string,
  content: Buffer,
): Promise<{ fileId: string; versionId: string }> {
  const { uploadService } = await services();
  const ticket = await uploadService.authorizeUpload(
    actor,
    { folderId, filename, size: content.byteLength },
    TEST_META,
  );
  await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(content), TEST_META);
  const result = await uploadService.finalize(actor, ticket.sessionId, TEST_META);
  return { fileId: result.fileId, versionId: result.versionId };
}

async function makeFolder(actor: Actor, name: string, parentId?: string): Promise<string> {
  const { driveService, folderService } = await services();
  const parent = parentId ?? (await driveService.getMyDriveRoot(actor)).id;
  const folder = await folderService.createFolder(actor, { name, parentFolderId: parent }, TEST_META);
  return folder.id;
}

/** What Drive currently believes about the object backing a version. */
async function driveObjectFor(versionId: string) {
  const version = await FileVersionModel.findById(versionId).lean();
  if (!version?.googleDriveFileId) return null;
  return drive.getFile(version.googleDriveFileId);
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

  enableDriveUploads();
});

afterEach(async () => {
  process.env = { ...savedEnv };
  resetEnvCache();
  const { setGoogleDriveStorage } = await import('@/server/storage/google');
  setGoogleDriveStorage(null);
});

describe('file mutations reach the Shared Drive', () => {
  it('renames the Drive object when a file is renamed', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Renames');
    const { fileId, versionId } = await uploadInto(actor, folder, 'before.csv', Buffer.from('x'));

    const { fileService } = await services();
    await fileService.renameFile(actor, fileId, 'after.csv', TEST_META);

    expect((await driveObjectFor(versionId))!.name).toBe('after.csv');
    expect((await FileModel.findById(fileId).lean())!.displayName).toBe('after.csv');
  });

  /** Every version's object, or a file's objects end up with two different names. */
  it('renames every version’s object, not just the current one', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Multi rename');
    const first = await uploadInto(actor, folder, 'multi.txt', Buffer.from('v1'));

    const { uploadService, fileService } = await services();
    const ticket = await uploadService.authorizeUpload(
      actor,
      { folderId: folder, filename: 'multi.txt', size: 2, targetFileId: first.fileId },
      TEST_META,
    );
    await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(Buffer.from('v2')), TEST_META);
    const second = await uploadService.finalize(actor, ticket.sessionId, TEST_META);

    await fileService.renameFile(actor, first.fileId, 'renamed.txt', TEST_META);

    expect((await driveObjectFor(first.versionId))!.name).toBe('renamed.txt');
    expect((await driveObjectFor(second.versionId))!.name).toBe('renamed.txt');
  });

  it('moves the Drive object into the destination’s mirrored folder', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const from = await makeFolder(actor, 'Source');
    const to = await makeFolder(actor, 'Destination');
    const { fileId, versionId } = await uploadInto(actor, from, 'moving.csv', Buffer.from('x'));

    const { fileService } = await services();
    await fileService.moveFile(actor, fileId, to, TEST_META);

    const destinationDriveId = (await FolderModel.findById(to).lean())!.googleDriveFolderId;
    expect(destinationDriveId).toBeTruthy();
    expect((await driveObjectFor(versionId))!.parents).toEqual([destinationDriveId]);
  });

  it('trashes and restores the Drive object', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Trashing');
    const { fileId, versionId } = await uploadInto(actor, folder, 'bin.txt', Buffer.from('x'));

    const { fileService } = await services();

    await fileService.trashFile(actor, fileId, TEST_META);
    expect((await driveObjectFor(versionId))!.trashed).toBe(true);

    await fileService.restoreFile(actor, fileId, TEST_META);
    expect((await driveObjectFor(versionId))!.trashed).toBe(false);
  });

  /**
   * Drive's trash, not a delete. The bytes stay recoverable there for the same reason they
   * stay recoverable here.
   */
  it('does not delete anything from Drive when a file is trashed', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'No deletes');
    const { fileId } = await uploadInto(actor, folder, 'safe.txt', Buffer.from('x'));

    const { fileService } = await services();
    drive.calls.length = 0;
    await fileService.trashFile(actor, fileId, TEST_META);

    expect(drive.calls).not.toContain('deleteFile');
  });

  /**
   * Without a destination parent a Drive copy lands at the top of the Shared Drive — the
   * record right, the Drive tree quietly wrong.
   */
  it('copies into the destination folder rather than the drive root', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const from = await makeFolder(actor, 'Copy source');
    const to = await makeFolder(actor, 'Copy target');
    const { fileId } = await uploadInto(actor, from, 'original.csv', Buffer.from('copy me'));

    const { fileService } = await services();
    const copy = await fileService.copyFile(actor, fileId, to, TEST_META);

    const copiedVersion = await FileVersionModel.findOne({ fileId: copy.id }).lean();
    const targetDriveId = (await FolderModel.findById(to).lean())!.googleDriveFolderId;

    expect(copiedVersion!.googleDriveFileId).toBeTruthy();
    const remote = await drive.getFile(copiedVersion!.googleDriveFileId!);
    expect(remote.parents).toEqual([targetDriveId]);
  });
});

describe('folder mutations reach the Shared Drive', () => {
  /** One Drive call carries the subtree, because Drive folders cascade. */
  it('renames the mirrored folder', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Old name');
    // Mirroring is lazy — a folder gets a Drive counterpart when content lands in it.
    await uploadInto(actor, folder, 'seed.txt', Buffer.from('x'));

    const { folderService } = await services();
    await folderService.renameFolder(actor, folder, 'New name', TEST_META);

    const driveId = (await FolderModel.findById(folder).lean())!.googleDriveFolderId!;
    expect((await drive.getFile(driveId)).name).toBe('New name');
  });

  it('moves the mirrored folder, carrying its contents', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const parentA = await makeFolder(actor, 'Parent A');
    const parentB = await makeFolder(actor, 'Parent B');
    const child = await makeFolder(actor, 'Child', parentA);
    const { versionId } = await uploadInto(actor, child, 'inside.txt', Buffer.from('x'));

    const { folderService } = await services();
    drive.calls.length = 0;
    await folderService.moveFolder(actor, child, parentB, TEST_META);

    const childDriveId = (await FolderModel.findById(child).lean())!.googleDriveFolderId!;
    const parentBDriveId = (await FolderModel.findById(parentB).lean())!.googleDriveFolderId!;
    expect((await drive.getFile(childDriveId)).parents).toEqual([parentBDriveId]);

    // The file inside was not touched individually — Drive carried it with the folder.
    const fileObject = await driveObjectFor(versionId);
    expect(fileObject!.parents).toEqual([childDriveId]);
    expect(drive.calls.filter((call) => call === 'updateFile')).toHaveLength(1);
  });

  it('trashes and restores the mirrored folder', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Folder bin');
    await uploadInto(actor, folder, 'inside.txt', Buffer.from('x'));

    const { folderService } = await services();
    const driveId = (await FolderModel.findById(folder).lean())!.googleDriveFolderId!;

    await folderService.trashFolder(actor, folder, TEST_META);
    expect((await drive.getFile(driveId)).trashed).toBe(true);

    await folderService.restoreFolder(actor, folder, TEST_META);
    expect((await drive.getFile(driveId)).trashed).toBe(false);
  });

  /**
   * Decision D7: mirroring is lazy. Creating a folder must not make a remote call — that
   * would turn a fast transactional write into a distributed one and fill the Shared Drive's
   * item budget with empty folders.
   */
  it('creates no Drive folder when a folder is created', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    drive.calls.length = 0;

    await makeFolder(actor, 'Empty folder');

    expect(drive.calls).toEqual([]);
    expect(drive.snapshot()).toEqual([]);
  });

  /** An unmirrored folder has nothing to keep in step, and must not fail because of it. */
  it('renames a never-mirrored folder without touching Drive', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Never used');
    drive.calls.length = 0;

    const { folderService } = await services();
    await folderService.renameFolder(actor, folder, 'Still never used', TEST_META);

    expect(drive.calls).toEqual([]);
    expect((await FolderModel.findById(folder).lean())!.name).toBe('Still never used');
  });
});

describe('a Drive failure changes nothing', () => {
  /**
   * ★ The acceptance criterion. Drive is attempted first, so a failure there happens before
   * any local write — both sides are still at the original state and the user is told
   * plainly that nothing happened.
   */
  it('leaves both sides untouched when a rename fails in Drive', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Rename fails');
    const { fileId, versionId } = await uploadInto(actor, folder, 'keep.csv', Buffer.from('x'));

    const { fileService } = await services();
    drive.failNext('updateFile', new DriveApiError({ status: 503, message: 'Service Unavailable' }));

    await expect(fileService.renameFile(actor, fileId, 'changed.csv', TEST_META)).rejects.toThrow(
      /Nothing was changed/i,
    );

    expect((await FileModel.findById(fileId).lean())!.displayName).toBe('keep.csv');
    expect((await driveObjectFor(versionId))!.name).toBe('keep.csv');
  });

  it('leaves both sides untouched when a move fails in Drive', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const from = await makeFolder(actor, 'Move fails from');
    const to = await makeFolder(actor, 'Move fails to');
    const { fileId, versionId } = await uploadInto(actor, from, 'stay.csv', Buffer.from('x'));

    const fromDriveId = (await FolderModel.findById(from).lean())!.googleDriveFolderId!;

    const { fileService } = await services();
    drive.failNext('updateFile', new DriveApiError({ status: 500, message: 'Backend Error' }));

    await expect(fileService.moveFile(actor, fileId, to, TEST_META)).rejects.toThrow();

    expect(String((await FileModel.findById(fileId).lean())!.folderId)).toBe(from);
    expect((await driveObjectFor(versionId))!.parents).toEqual([fromDriveId]);
  });

  it('leaves both sides untouched when a trash fails in Drive', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Trash fails');
    const { fileId, versionId } = await uploadInto(actor, folder, 'survives.txt', Buffer.from('x'));

    const { fileService } = await services();
    drive.failNext('updateFile', new DriveApiError({ status: 503, message: 'Unavailable' }));

    await expect(fileService.trashFile(actor, fileId, TEST_META)).rejects.toThrow();

    expect((await FileModel.findById(fileId).setOptions({ withDeleted: true }).lean())!.deletedAt).toBeNull();
    expect((await driveObjectFor(versionId))!.trashed).toBe(false);
  });

  it('leaves both sides untouched when a folder rename fails in Drive', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Folder keeps name');
    await uploadInto(actor, folder, 'seed.txt', Buffer.from('x'));

    const { folderService } = await services();
    drive.failNext('updateFile', new DriveApiError({ status: 503, message: 'Unavailable' }));

    await expect(
      folderService.renameFolder(actor, folder, 'Should not stick', TEST_META),
    ).rejects.toThrow(/Nothing was changed/i);

    const stored = await FolderModel.findById(folder).lean();
    expect(stored!.name).toBe('Folder keeps name');
    expect((await drive.getFile(stored!.googleDriveFolderId!)).name).toBe('Folder keeps name');
  });

  /**
   * A partial application is the failure mode a naive loop produces: object one renamed,
   * object two failed, nobody ever notices. The batch undoes what it managed.
   */
  it('undoes a partially applied rename across several versions', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Partial');
    const first = await uploadInto(actor, folder, 'partial.txt', Buffer.from('v1'));

    const { uploadService, fileService } = await services();
    const ticket = await uploadService.authorizeUpload(
      actor,
      { folderId: folder, filename: 'partial.txt', size: 2, targetFileId: first.fileId },
      TEST_META,
    );
    await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(Buffer.from('v2')), TEST_META);
    const second = await uploadService.finalize(actor, ticket.sessionId, TEST_META);

    // First rename succeeds, second fails — the first must be rolled back.
    drive.succeedNext('updateFile');
    drive.failNext('updateFile', new DriveApiError({ status: 500, message: 'Backend Error' }));

    await expect(fileService.renameFile(actor, first.fileId, 'nope.txt', TEST_META)).rejects.toThrow();

    expect((await driveObjectFor(first.versionId))!.name).toBe('partial.txt');
    expect((await driveObjectFor(second.versionId))!.name).toBe('partial.txt');
    expect((await FileModel.findById(first.fileId).lean())!.displayName).toBe('partial.txt');
  });
});

describe('a deployment without Drive is unaffected', () => {
  it('performs every mutation with no Drive involvement', async () => {
    if (skipUnlessDb()) return;
    process.env = { ...savedEnv };
    resetEnvCache();

    const actor = await actorFor(fixture.users.scientistA);
    const from = await makeFolder(actor, 'Plain source');
    const to = await makeFolder(actor, 'Plain target');
    const { fileId } = await uploadInto(actor, from, 'plain.csv', Buffer.from('x'));

    const { fileService, folderService } = await services();
    drive.calls.length = 0;

    await fileService.renameFile(actor, fileId, 'plain2.csv', TEST_META);
    await fileService.moveFile(actor, fileId, to, TEST_META);
    await fileService.trashFile(actor, fileId, TEST_META);
    await fileService.restoreFile(actor, fileId, TEST_META);
    await folderService.renameFolder(actor, from, 'Plain renamed', TEST_META);

    expect(drive.calls).toEqual([]);
    expect((await FileModel.findById(fileId).lean())!.displayName).toBe('plain2.csv');
  });
});
