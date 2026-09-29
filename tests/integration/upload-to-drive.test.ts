/**
 * Phase 6 — new uploads reaching Google Drive.
 *
 * The design being asserted here is that **an upload never depends on Google.** The file is
 * written locally, verified, scanned and recorded first; only then is it handed to Drive.
 * So the interesting tests are not "does it get there" — they are:
 *
 *   • Drive is down. Does the upload still succeed, and is the file still readable?
 *   • Drive rejects the transfer. Is the file harmed in any way?
 *   • A large file. Is the employee made to wait for the transfer?
 *   • Does the file end up in the same state a *migrated* file is in, so that Phase 4's
 *     fallback and Phase 5's rollback both apply to it?
 *
 * That last one is the point of reusing Phase 5's transfer rather than writing a second
 * upload-specific one: a newly uploaded file and a migrated file must be indistinguishable
 * afterwards, or every guarantee built in Phases 3–5 applies to only half the corpus.
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

/**
 * Switches this deployment to "new uploads go to Drive".
 *
 * The real `handOffToDrive` reads these two values from the environment, so the test has to
 * set them rather than inject a flag — otherwise it would be exercising a different code
 * path from the one production takes.
 */
function enableDriveUploads(options: { syncThresholdMb?: number } = {}): void {
  process.env.GOOGLE_DRIVE_STORAGE_ENABLED = 'true';
  process.env.DEFAULT_STORAGE_PROVIDER = 'google_drive';
  process.env.GOOGLE_SHARED_DRIVE_ID = 'drive-company';
  process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL = 'sa@example.iam.gserviceaccount.com';
  process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY =
    '-----BEGIN PRIVATE KEY-----\\nunused\\n-----END PRIVATE KEY-----';
  if (options.syncThresholdMb !== undefined) {
    process.env.UPLOAD_DRIVE_SYNC_THRESHOLD_MB = String(options.syncThresholdMb);
  }
  resetEnvCache();
}

async function services() {
  return {
    uploadService: (await import('@/server/services/upload.service')).uploadService,
    downloadService: (await import('@/server/services/download.service')).downloadService,
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

async function makeFolder(actor: Actor, name: string): Promise<string> {
  const { driveService, folderService } = await services();
  const root = await driveService.getMyDriveRoot(actor);
  const folder = await folderService.createFolder(actor, { name, parentFolderId: root.id }, TEST_META);
  return folder.id;
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

  // Two seams, because the upload path uses both: the registry supplies the object store
  // and the folder hierarchy, while the raw Drive *client* — used for the orphan search and
  // the read-back verification — comes from the module singleton. Injecting only one leaves
  // the other reaching for the real Google.
  const { getObjectStore, storageRegistry } = await import('@/server/storage');
  getObjectStore('local');
  storageRegistry.register({ objects: store, hierarchy: store });

  const { setGoogleDriveStorage } = await import('@/server/storage/google');
  setGoogleDriveStorage({ client: drive, store });
});

afterEach(async () => {
  // Both are global; leaving them set would silently change every later suite.
  process.env = { ...savedEnv };
  resetEnvCache();
  const { setGoogleDriveStorage } = await import('@/server/storage/google');
  setGoogleDriveStorage(null);
});

describe('when new uploads are configured to go to Drive', () => {
  it('stores the file in Drive and serves it back byte-identically', async () => {
    if (skipUnlessDb()) return;
    enableDriveUploads();

    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Drive uploads');
    const content = Buffer.from('sample,ct\nS-90,21.7\n');

    const { fileId, versionId } = await uploadInto(actor, folder, 'fresh.csv', content);

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.storageProvider).toBe('google_drive');
    expect(version!.googleDriveFileId).toBeTruthy();
    expect(version!.migrationStatus).toBe('verified');

    const { downloadService } = await services();
    const stream = await downloadService.download(actor, fileId, {}, TEST_META);
    expect(await collect(stream.body)).toEqual(content);
  });

  /**
   * A newly uploaded file must be in exactly the state a migrated one is in. Otherwise
   * Phase 4's missing-object fallback and Phase 5's rollback apply to only half the corpus.
   */
  it('leaves a new upload indistinguishable from a migrated file', async () => {
    if (skipUnlessDb()) return;
    enableDriveUploads();

    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Same shape');
    const content = Buffer.from('identical treatment');

    const { versionId } = await uploadInto(actor, folder, 'shape.txt', content);
    const version = await FileVersionModel.findById(versionId).lean();

    // The local copy is kept and its key is intact — the rollback path depends on both.
    expect(version!.storageKey).toBeTruthy();
    expect(version!.localCopyState).toBe('present');
    expect(version!.localCopyEligibleForDeletionAt).toBeTruthy();
    expect(version!.googleDriveMd5).toBeTruthy();
    expect(version!.syncStatus).toBe('synced');

    const { getStorageProvider } = await import('@/server/storage');
    const local = await getStorageProvider().getFile(version!.storageKey, version!.storageArea as never);
    expect(await collect(local)).toEqual(content);
  });

  /**
   * ★ The design premise. If Google is unreachable, an employee must still be able to save
   * their work — and to open it again immediately.
   */
  it('still accepts the upload when Drive is completely unavailable', async () => {
    if (skipUnlessDb()) return;
    enableDriveUploads();

    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Drive down');
    const content = Buffer.from('the work still gets saved');

    drive.failNext('uploadFile', new DriveApiError({ status: 503, message: 'Service Unavailable' }));

    // No throw. That is the assertion.
    const { fileId, versionId } = await uploadInto(actor, folder, 'resilient.txt', content);

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.storageProvider).toBe('local');
    // Queued, so a later drain picks it up — the backlog is visible, not lost.
    expect(version!.migrationStatus).toBe('queued');

    const { downloadService } = await services();
    expect(await collect((await downloadService.download(actor, fileId, {}, TEST_META)).body)).toEqual(
      content,
    );
  });

  it('does not harm the file when Drive rejects the transfer outright', async () => {
    if (skipUnlessDb()) return;
    enableDriveUploads();

    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Drive refuses');
    const content = Buffer.from('permission denied over there');

    drive.failNext(
      'uploadFile',
      new DriveApiError({ status: 403, reason: 'insufficientFilePermissions', message: 'Denied' }),
    );

    const { fileId, versionId } = await uploadInto(actor, folder, 'denied.txt', content);

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.storageProvider).toBe('local');
    expect(version!.googleDriveFileId).toBeNull();
    expect(version!.checksumSha256).toBeTruthy();

    const { downloadService } = await services();
    expect(await collect((await downloadService.download(actor, fileId, {}, TEST_META)).body)).toEqual(
      content,
    );
  });

  /**
   * Above the threshold the employee is not made to wait. The file is complete and readable
   * the moment finalize returns; only its bytes' final home is deferred.
   */
  it('queues a large file rather than transferring it during the request', async () => {
    if (skipUnlessDb()) return;
    // 0 MB threshold: everything counts as large, which is how this is testable without
    // actually uploading a gigabyte.
    enableDriveUploads({ syncThresholdMb: 0 });

    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Large file');
    const content = Buffer.from('pretend this is very large');

    const { fileId, versionId } = await uploadInto(actor, folder, 'big.txt', content);

    // Nothing was sent to Drive during the upload.
    expect(drive.calls).not.toContain('uploadFile');

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.storageProvider).toBe('local');
    expect(version!.migrationStatus).toBe('queued');

    // And it is immediately usable.
    const { downloadService } = await services();
    expect(await collect((await downloadService.download(actor, fileId, {}, TEST_META)).body)).toEqual(
      content,
    );
  });

  it('drains the queue afterwards, reusing the migration transfer', async () => {
    if (skipUnlessDb()) return;
    enableDriveUploads({ syncThresholdMb: 0 });

    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Drain me');
    const content = Buffer.from('queued then moved');

    const { fileId, versionId } = await uploadInto(actor, folder, 'queued.txt', content);

    const { drainPendingTransfers, countPending } = await import(
      '@/server/services/storage-migration/pending-transfers'
    );
    const store = new GoogleDriveObjectStore(drive, driveConfig());

    expect(await countPending()).toBeGreaterThan(0);
    const result = await drainPendingTransfers({
      deps: { store, client: drive, hierarchy: store },
    });

    expect(result.transferred).toBeGreaterThan(0);

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.storageProvider).toBe('google_drive');
    expect(version!.migrationStatus).toBe('verified');

    const { downloadService } = await services();
    expect(await collect((await downloadService.download(actor, fileId, {}, TEST_META)).body)).toEqual(
      content,
    );
  });

  /**
   * A drain that runs twice — because cron overlapped, or an administrator pressed the
   * button while the scheduler was already working — must not produce a second Drive object.
   */
  it('does not duplicate when the drain runs twice', async () => {
    if (skipUnlessDb()) return;
    enableDriveUploads({ syncThresholdMb: 0 });

    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Double drain');
    await uploadInto(actor, folder, 'once.txt', Buffer.from('only one object'));

    const { drainPendingTransfers } = await import(
      '@/server/services/storage-migration/pending-transfers'
    );
    const store = new GoogleDriveObjectStore(drive, driveConfig());
    const deps = { store, client: drive, hierarchy: store };

    await drainPendingTransfers({ deps });
    const objectsAfterFirst = drive.snapshot().filter((i) => !i.mimeType.includes('folder')).length;

    await drainPendingTransfers({ deps });
    expect(drive.snapshot().filter((i) => !i.mimeType.includes('folder'))).toHaveLength(
      objectsAfterFirst,
    );
  });

  it('sends a new version of an existing file to Drive too', async () => {
    if (skipUnlessDb()) return;
    enableDriveUploads();

    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Versions to drive');
    const v1 = Buffer.from('first');
    const v2 = Buffer.from('second, revised');

    const first = await uploadInto(actor, folder, 'versioned.txt', v1);

    const { uploadService, downloadService } = await services();
    const ticket = await uploadService.authorizeUpload(
      actor,
      { folderId: folder, filename: 'versioned.txt', size: v2.byteLength, targetFileId: first.fileId },
      TEST_META,
    );
    await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(v2), TEST_META);
    const second = await uploadService.finalize(actor, ticket.sessionId, TEST_META);

    for (const versionId of [first.versionId, second.versionId]) {
      const version = await FileVersionModel.findById(versionId).lean();
      expect(version!.storageProvider).toBe('google_drive');
    }

    // Both versions still readable, each from its own Drive object.
    expect(await collect((await downloadService.download(actor, first.fileId, {}, TEST_META)).body)).toEqual(v2);
    expect(
      await collect(
        (await downloadService.download(actor, first.fileId, { versionId: first.versionId }, TEST_META)).body,
      ),
    ).toEqual(v1);
  });
});

describe('when new uploads are still configured for local storage', () => {
  /**
   * Having Drive *connected* is not the same as having new uploads *go* there. A deployment
   * mid-migration is in exactly that state, and must keep writing locally until it is
   * switched over — which is why the two settings are separate.
   */
  it('does not touch Drive at all', async () => {
    if (skipUnlessDb()) return;
    process.env.GOOGLE_DRIVE_STORAGE_ENABLED = 'true';
    process.env.DEFAULT_STORAGE_PROVIDER = 'local';
    process.env.GOOGLE_SHARED_DRIVE_ID = 'drive-company';
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL = 'sa@example.iam.gserviceaccount.com';
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY =
      '-----BEGIN PRIVATE KEY-----\\nunused\\n-----END PRIVATE KEY-----';
    resetEnvCache();

    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Still local');
    const content = Buffer.from('stays here for now');

    const { versionId } = await uploadInto(actor, folder, 'local.txt', content);

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.storageProvider).toBe('local');
    // Not even queued — nothing has asked for it to move.
    expect(version!.migrationStatus).toBe('not_started');
    expect(drive.calls).toEqual([]);
  });

  it('behaves exactly as before when Drive is switched off entirely', async () => {
    if (skipUnlessDb()) return;

    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Drive off');
    const content = Buffer.from('unchanged behaviour');

    const { fileId, versionId } = await uploadInto(actor, folder, 'off.txt', content);

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.storageProvider).toBe('local');
    expect(version!.migrationStatus).toBe('not_started');
    expect(drive.calls).toEqual([]);

    const { downloadService } = await services();
    expect(await collect((await downloadService.download(actor, fileId, {}, TEST_META)).body)).toEqual(
      content,
    );
  });
});
