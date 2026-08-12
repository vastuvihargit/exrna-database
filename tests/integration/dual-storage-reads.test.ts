/**
 * Phase 4 — reading a file whose bytes may be anywhere.
 *
 * The setup is the point: a file is uploaded normally (so it is genuinely local, with real
 * quarantine, hashing and finalize behind it), its bytes are then copied into an in-memory
 * Shared Drive and the record flipped to `google_drive` — which is exactly what the Phase 5
 * migration will do. Everything after that is a read, and every read must behave
 * identically to the local one it replaced.
 *
 * The failure tests are the reason this file exists. §16 of the brief says a Drive object
 * that has vanished must never delete the MongoDB record, must be marked, and must fall
 * back to the retained local copy. That is the payoff for `storageKey` never being cleared,
 * and it is worth nothing unless it is exercised.
 */
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { actorFor, seedFixture, TEST_META, type Fixture } from '../helpers/fixtures';
import { FakeDriveClient } from '../helpers/fake-drive';
import type { Actor } from '@/server/permissions/actor';
import { DriveApiError } from '@/server/storage/google/drive-errors';
import { GoogleDriveObjectStore } from '@/server/storage/google/google-drive-object-store';
import type { DriveStorageConfig } from '@/server/storage/google/drive-config';
import { FileVersionModel } from '@/server/db/models/file-version.model';

let db: TestDb;
let fixture: Fixture;
let drive: FakeDriveClient;

const DRIVE_ROOT = 'root-folder';

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

async function services() {
  return {
    downloadService: (await import('@/server/services/download.service')).downloadService,
    uploadService: (await import('@/server/services/upload.service')).uploadService,
    driveService: (await import('@/server/services/drive.service')).driveService,
    folderService: (await import('@/server/services/folder.service')).folderService,
  };
}

async function collect(body: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Replaces whatever Drive implementation the registry holds with one backed by the fake.
 *
 * The registry is populated lazily, so `getObjectStore('local')` is called first to force
 * that to happen — otherwise the later registration would be wiped when it did.
 */
async function registerFakeDrive(): Promise<void> {
  const { getObjectStore, storageRegistry } = await import('@/server/storage');
  getObjectStore('local');

  const store = new GoogleDriveObjectStore(drive, driveConfig());
  storageRegistry.register({ objects: store, hierarchy: store });
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

async function personalFolder(actor: Actor, name: string): Promise<string> {
  const { driveService, folderService } = await services();
  const root = await driveService.getMyDriveRoot(actor);
  const folder = await folderService.createFolder(
    actor,
    { name, parentFolderId: root.id },
    TEST_META,
  );
  return folder.id;
}

/**
 * Does exactly what the Phase 5 migration will: puts the bytes in Drive, records the id,
 * and leaves the local copy in place. Deliberately not a shortcut that fabricates a record
 * — the point is to read something that went through the real path.
 */
async function migrateToDrive(
  versionId: string,
  content: Buffer,
  options: { filename?: string } = {},
): Promise<string> {
  const uploaded = drive.seedFile({
    name: options.filename ?? 'object.bin',
    parentId: DRIVE_ROOT,
    content,
  });

  await FileVersionModel.updateOne(
    { _id: versionId },
    {
      $set: {
        storageProvider: 'google_drive',
        googleDriveFileId: uploaded.id,
        googleDriveRevisionId: uploaded.headRevisionId ?? null,
        migrationStatus: 'verified',
        migratedAt: new Date(),
        localCopyState: 'present',
      },
    },
  );

  return uploaded.id;
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
  if (db.available) await registerFakeDrive();
});

describe('a migrated file reads exactly like a local one', () => {
  it('downloads byte-identical content from Google Drive', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await personalFolder(actor, 'Drive reads');
    const content = Buffer.from('sample,reading\nS-001,1.44\n');

    const { fileId, versionId } = await uploadInto(actor, folder, 'assay.csv', content);
    const { downloadService } = await services();

    // Before: local.
    const local = await downloadService.download(actor, fileId, {}, TEST_META);
    expect(await collect(local.body)).toEqual(content);

    await migrateToDrive(versionId, content);

    // After: Drive. Same call, same bytes, same descriptor shape.
    const migrated = await downloadService.download(actor, fileId, {}, TEST_META);
    expect(await collect(migrated.body)).toEqual(content);
    expect(migrated.contentLength).toBe(content.byteLength);
    expect(migrated.totalSize).toBe(content.byteLength);
    expect(migrated.etag).toBe(local.etag);
    expect(migrated.contentDisposition).toBe(local.contentDisposition);
  });

  it('serves a byte range from Google Drive', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await personalFolder(actor, 'Drive ranges');
    const content = Buffer.from('0123456789abcdefghij');

    const { fileId, versionId } = await uploadInto(actor, folder, 'nums.csv', content);
    await migrateToDrive(versionId, content);

    const { downloadService } = await services();
    const ranged = await downloadService.download(
      actor,
      fileId,
      { rangeHeader: 'bytes=4-9' },
      TEST_META,
    );

    expect(ranged.range).toEqual({ start: 4, end: 9 });
    expect(ranged.contentLength).toBe(6);
    expect(await collect(ranged.body)).toEqual(Buffer.from('456789'));
  });

  it('previews from Google Drive', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await personalFolder(actor, 'Drive preview');
    const content = Buffer.from('id,value\n1,2\n');

    const { fileId, versionId } = await uploadInto(actor, folder, 'table.csv', content);
    await migrateToDrive(versionId, content);

    const { downloadService } = await services();
    const preview = await downloadService.preview(actor, fileId, {}, TEST_META);
    expect(await collect(preview.body)).toEqual(content);
  });

  /**
   * Both providers in one file, which is the state the whole migration lives in: an old
   * version still local, the current one already in Drive.
   */
  it('serves one file whose versions live in different providers', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await personalFolder(actor, 'Mixed providers');
    const v1 = Buffer.from('version one');
    const v2 = Buffer.from('version two, longer');

    const first = await uploadInto(actor, folder, 'mixed.txt', v1);

    const { uploadService, downloadService } = await services();
    const ticket = await uploadService.authorizeUpload(
      actor,
      { folderId: folder, filename: 'mixed.txt', size: v2.byteLength, targetFileId: first.fileId },
      TEST_META,
    );
    await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(v2), TEST_META);
    const second = await uploadService.finalize(actor, ticket.sessionId, TEST_META);

    // Only the current version moves; v1 stays on this server.
    await migrateToDrive(second.versionId, v2);

    expect(await collect((await downloadService.download(actor, first.fileId, {}, TEST_META)).body)).toEqual(v2);
    expect(
      await collect(
        (await downloadService.download(actor, first.fileId, { versionId: first.versionId }, TEST_META)).body,
      ),
    ).toEqual(v1);
  });

  /** Permission is decided before storage is touched, and that does not change by provider. */
  it('still refuses a reader who has no access to a Drive-backed file', async () => {
    if (skipUnlessDb()) return;
    const owner = await actorFor(fixture.users.scientistA);
    const stranger = await actorFor(fixture.users.scientistB);
    const folder = await personalFolder(owner, 'Private drive file');
    const content = Buffer.from('confidential');

    const { fileId, versionId } = await uploadInto(owner, folder, 'secret.txt', content);
    await migrateToDrive(versionId, content);

    const { downloadService } = await services();
    await expect(downloadService.download(stranger, fileId, {}, TEST_META)).rejects.toThrow();
    // And nothing was read on their behalf.
    expect(drive.calls).not.toContain('downloadFile');
  });
});

describe('when the Drive object has vanished', () => {
  /**
   * ★ The payoff for never clearing `storageKey`. Someone empties the Shared Drive trash;
   * the employee's download still works, and an administrator finds out.
   */
  it('serves the retained local copy and marks the record as conflicted', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await personalFolder(actor, 'Vanished');
    const content = Buffer.from('irreplaceable results');

    const { fileId, versionId } = await uploadInto(actor, folder, 'results.txt', content);
    const driveFileId = await migrateToDrive(versionId, content);

    // Deleted directly in the Drive web UI, or purged from the Drive trash.
    await drive.deleteFile(driveFileId);

    const { downloadService } = await services();
    const stream = await downloadService.download(actor, fileId, {}, TEST_META);

    expect(await collect(stream.body)).toEqual(content);

    const version = await FileVersionModel.findById(versionId);
    expect(version).not.toBeNull();
    expect(version!.syncStatus).toBe('conflict');
    // The record is marked, never removed — the metadata, approvals and audit history for
    // this file all still hang off it.
    expect(version!.storageKey).toBeTruthy();
    expect(version!.googleDriveFileId).toBe(driveFileId);
  });

  it('fails cleanly, and still keeps the record, when the local copy is gone too', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await personalFolder(actor, 'Doubly gone');
    const content = Buffer.from('nothing left');

    const { fileId, versionId } = await uploadInto(actor, folder, 'gone.txt', content);
    const driveFileId = await migrateToDrive(versionId, content);
    await drive.deleteFile(driveFileId);

    // The local copy was deleted after the retention window, as Phase 11 permits.
    await FileVersionModel.updateOne({ _id: versionId }, { $set: { localCopyState: 'deleted' } });

    const { downloadService } = await services();
    await expect(downloadService.download(actor, fileId, {}, TEST_META)).rejects.toThrow(
      /currently unavailable/i,
    );

    const version = await FileVersionModel.findById(versionId);
    expect(version).not.toBeNull();
    expect(version!.syncStatus).toBe('conflict');
  });

  /**
   * The other half of the classification, and the more dangerous one to get wrong. A
   * five-minute Google outage must not mark thousands of healthy files as conflicts, and
   * must not quietly serve a stale local copy as though nothing happened.
   */
  it('does not treat a transient Drive failure as a missing object', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await personalFolder(actor, 'Transient');
    const content = Buffer.from('still there');

    const { fileId, versionId } = await uploadInto(actor, folder, 'blip.txt', content);
    await migrateToDrive(versionId, content);

    drive.failNext('downloadFile', new DriveApiError({ status: 500, message: 'Backend Error' }));

    const { downloadService } = await services();
    await expect(downloadService.download(actor, fileId, {}, TEST_META)).rejects.toThrow();

    const version = await FileVersionModel.findById(versionId);
    expect(version!.syncStatus).not.toBe('conflict');
    expect(version!.storageProvider).toBe('google_drive');
  });

  it('does not treat a permissions failure as a missing object either', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await personalFolder(actor, 'Denied');
    const content = Buffer.from('present but unreadable');

    const { fileId, versionId } = await uploadInto(actor, folder, 'denied.txt', content);
    await migrateToDrive(versionId, content);

    drive.failNext(
      'downloadFile',
      new DriveApiError({ status: 403, reason: 'insufficientFilePermissions', message: 'Denied' }),
    );

    const { downloadService } = await services();
    await expect(downloadService.download(actor, fileId, {}, TEST_META)).rejects.toThrow();

    const version = await FileVersionModel.findById(versionId);
    expect(version!.syncStatus).not.toBe('conflict');
  });
});

describe('Google-native documents', () => {
  /**
   * A Doc has no bytes. Reading it has to become an export, and what the employee receives
   * is a .docx — so the extension, the content type and the length all differ from what is
   * stored. Getting the extension wrong hands someone a file their computer cannot open.
   */
  it('exports a native document instead of failing to read it', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await personalFolder(actor, 'Native docs');
    const placeholder = Buffer.from('placeholder');

    const { fileId, versionId } = await uploadInto(actor, folder, 'Protocol.txt', placeholder);

    const doc = drive.seedNativeDocument({ name: 'Protocol', parentId: DRIVE_ROOT });
    await FileVersionModel.updateOne(
      { _id: versionId },
      {
        $set: {
          storageProvider: 'google_drive',
          googleDriveFileId: doc.id,
          googleDriveRevisionId: doc.headRevisionId ?? 'rev-1',
          isGoogleNative: true,
          googleNativeKind: 'document',
          migrationStatus: 'verified',
        },
      },
    );

    const { downloadService } = await services();
    const stream = await downloadService.download(actor, fileId, {}, TEST_META);

    const body = (await collect(stream.body)).toString();
    expect(body).toContain('wordprocessingml');
    expect(stream.contentType).toContain('wordprocessingml');
    expect(stream.contentDisposition).toContain('.docx');
    // Unknown until produced — reporting 0 would hand the browser an empty file.
    expect(stream.contentLength).toBeNull();
    expect(stream.acceptRanges).toBe(false);
  });

  /** A range over a generated export is meaningless, so it must not be claimed as honoured. */
  it('ignores a byte range on an export rather than answering a false 206', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await personalFolder(actor, 'Native ranges');

    const { fileId, versionId } = await uploadInto(actor, folder, 'Sheet.txt', Buffer.from('x'));
    const sheet = drive.seedNativeDocument({
      name: 'Sheet',
      parentId: DRIVE_ROOT,
      kind: 'spreadsheet',
    });
    await FileVersionModel.updateOne(
      { _id: versionId },
      {
        $set: {
          storageProvider: 'google_drive',
          googleDriveFileId: sheet.id,
          isGoogleNative: true,
          googleNativeKind: 'spreadsheet',
        },
      },
    );

    const { downloadService } = await services();
    const stream = await downloadService.download(
      actor,
      fileId,
      { rangeHeader: 'bytes=0-5' },
      TEST_META,
    );

    expect(stream.range).toBeUndefined();
    expect(stream.contentDisposition).toContain('.xlsx');
  });
});
