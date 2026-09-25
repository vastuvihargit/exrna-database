/**
 * Phase 7 — uploads staged **in** Google Drive, which is the pipeline a Worker runs.
 *
 * The sibling suite `upload-to-drive.test.ts` covers the other configuration: bytes written
 * locally, then handed to Drive, with the local copy retained as the rollback plan. That one is
 * still the default and is unchanged. This one covers `UPLOAD_STAGING=google_drive`, where
 * there is no disk at all.
 *
 * What is worth asserting here is not "does the file arrive" — it is the set of properties the
 * local pipeline got from having a disk, and which had to be rebuilt:
 *
 *   • The signature check happens **before** the body is transferred, not after.
 *   • Unverified bytes are never at an address any read path can resolve.
 *   • The checksum recorded is one the *server* measured over what Drive actually holds.
 *   • Promotion moves no bytes.
 *   • A rejected or abandoned upload leaves nothing behind in the Shared Drive.
 *   • A chunked upload survives a replayed chunk without corrupting the object.
 */
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { actorFor, seedFixture, TEST_META, type Fixture } from '../helpers/fixtures';
import { FakeDriveClient } from '../helpers/fake-drive';
import type { Actor } from '@/server/permissions/actor';
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
 * The Worker configuration, set through the environment rather than injected.
 *
 * `getUploadStaging()` reads these, so setting a flag directly would exercise a different code
 * path from the one a deployment takes — including the two cross-checks in `env.ts` that refuse
 * a half-configured combination.
 */
function stageInDrive(options: { chunkMb?: number } = {}): void {
  process.env.GOOGLE_DRIVE_STORAGE_ENABLED = 'true';
  process.env.DEFAULT_STORAGE_PROVIDER = 'google_drive';
  process.env.UPLOAD_STAGING = 'google_drive';
  process.env.GOOGLE_SHARED_DRIVE_ID = 'drive-company';
  process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL = 'sa@example.iam.gserviceaccount.com';
  process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY =
    '-----BEGIN PRIVATE KEY-----\\nunused\\n-----END PRIVATE KEY-----';
  if (options.chunkMb !== undefined) process.env.UPLOAD_CHUNK_SIZE_MB = String(options.chunkMb);
  resetEnvCache();
}

async function services() {
  return {
    uploadService: (await import('@/server/services/upload.service')).uploadService,
    downloadService: (await import('@/server/services/download.service')).downloadService,
    driveService: (await import('@/server/services/drive.service')).driveService,
    folderService: (await import('@/server/services/folder.service')).folderService,
    sessionRepository: await import('@/server/repositories/upload-session.repository'),
  };
}

async function collect(body: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function makeFolder(actor: Actor, name: string): Promise<string> {
  const { driveService, folderService } = await services();
  const root = await driveService.getMyDriveRoot(actor);
  const folder = await folderService.createFolder(actor, { name, parentFolderId: root.id }, TEST_META);
  return folder.id;
}

/** A minimal but real PDF head, so the signature check has something legitimate to accept. */
function pdf(body: string): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(body)]);
}

beforeAll(async () => {
  db = await startTestDb();
  if (!db.available) return;
  fixture = await seedFixture();
}, 180_000);

afterAll(async () => {
  if (db?.available) await stopTestDb();
});

beforeEach(async () => {
  if (!db?.available) return;

  drive = new FakeDriveClient({ driveId: 'drive-company' });
  drive.seedFolder({ name: 'Research', parentId: 'drive-company', appFolderId: 'root' });
  // The configured root has to exist for `ensureFolder(parentExternalId: null)` to hang the
  // staging folder off something.
  drive.seedFolder({ name: 'root', parentId: 'drive-company' });

  stageInDrive();

  const { setGoogleDriveStorage } = await import('@/server/storage/google');
  const { resetStorageRegistration } = await import('@/server/storage');
  const { setUploadStaging } = await import('@/server/storage/staging');

  setGoogleDriveStorage({ client: drive, store: new GoogleDriveObjectStore(drive, driveConfig()) });
  resetStorageRegistration();
  // Null clears the memoized backends so the next call rebuilds from the fake.
  setUploadStaging(null);
});

afterEach(async () => {
  process.env = { ...savedEnv };
  resetEnvCache();

  const { setGoogleDriveStorage } = await import('@/server/storage/google');
  const { resetStorageRegistration } = await import('@/server/storage');
  const { setUploadStaging } = await import('@/server/storage/staging');
  setGoogleDriveStorage(null);
  resetStorageRegistration();
  setUploadStaging(null);
});

describe('uploads staged in Google Drive', () => {
  it('records the file as living in Drive, with the checksum the server measured', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, downloadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await makeFolder(alice, 'Staged uploads');
    const content = pdf('sequencing run 42');

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'run-42.pdf', size: content.byteLength },
      TEST_META,
    );
    await uploadService.receiveStream(alice, ticket.sessionId, Readable.from(content), TEST_META);
    const result = await uploadService.finalize(alice, ticket.sessionId, TEST_META);

    // Measured, not declared: the digest is over what came back from Drive.
    expect(result.checksumSha256).toBe(createHash('sha256').update(content).digest('hex'));

    const version = await FileVersionModel.findById(result.versionId).lean<{
      storageProvider?: string;
      googleDriveFileId?: string | null;
      googleDriveParentId?: string | null;
    }>();
    expect(version?.storageProvider).toBe('google_drive');
    expect(version?.googleDriveFileId).toBeTruthy();

    // And it reads back byte-identically through the ordinary download path.
    const opened = await downloadService.download(alice, result.fileId, {}, TEST_META);
    expect(await collect(opened.body)).toEqual(content);
  });

  it('leaves nothing in the staging folder once the upload is promoted', async () => {
    if (skipUnlessDb()) return;
    const { uploadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await makeFolder(alice, 'Promotion');
    const content = pdf('promoted');

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'promoted.pdf', size: content.byteLength },
      TEST_META,
    );
    await uploadService.receiveStream(alice, ticket.sessionId, Readable.from(content), TEST_META);
    const result = await uploadService.finalize(alice, ticket.sessionId, TEST_META);

    const staging = drive.snapshot().find((item) => item.name === '.upload-staging');
    expect(staging, 'a staging folder should have been created').toBeTruthy();

    const stillStaged = drive
      .snapshot()
      .filter((item) => item.parents.includes(staging!.id) && !item.trashed);
    expect(stillStaged).toEqual([]);

    // Promotion is a re-parent, so the object kept its id and its bytes were never re-sent.
    const version = await FileVersionModel.findById(result.versionId).lean<{
      googleDriveFileId?: string | null;
    }>();
    const promoted = drive.snapshot().find((item) => item.id === version?.googleDriveFileId);
    expect(promoted?.parents.includes(staging!.id)).toBe(false);
    expect(drive.calls.filter((call) => call === 'uploadFile').length).toBeLessThanOrEqual(1);
  });

  it('refuses a mislabelled file before any of it is transferred', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, sessionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await makeFolder(alice, 'Signature');
    // A Windows executable wearing a .pdf name.
    const disguised = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(2048, 0x90)]);

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'protocol.pdf', size: disguised.byteLength },
      TEST_META,
    );

    const before = drive.snapshot().length;
    await expect(
      uploadService.receiveStream(alice, ticket.sessionId, Readable.from(disguised), TEST_META),
    ).rejects.toMatchObject({ status: 415 });

    // The whole point of buffering the head: nothing was uploaded at all.
    expect(drive.calls).not.toContain('uploadFile');
    expect(drive.calls).not.toContain('beginResumableUpload');
    expect(drive.snapshot().length).toBe(before);

    expect((await sessionRepository.findById(ticket.sessionId))?.status).toBe('rejected');
  });

  it('removes the staged object when an upload is aborted', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, sessionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await makeFolder(alice, 'Aborted');
    const content = pdf('never finished');

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'abandoned.pdf', size: content.byteLength },
      TEST_META,
    );
    await uploadService.receiveStream(alice, ticket.sessionId, Readable.from(content), TEST_META);

    const staged = (await sessionRepository.findById(ticket.sessionId))?.externalStagedId;
    expect(staged, 'the staged Drive id must be persisted on the session').toBeTruthy();
    expect(drive.snapshot().some((item) => item.id === staged)).toBe(true);

    await uploadService.abort(alice, ticket.sessionId);

    // Deleted, not trashed: a Shared Drive trash still holds the bytes and still counts.
    expect(drive.snapshot().some((item) => item.id === staged)).toBe(false);
    const after = await sessionRepository.findById(ticket.sessionId);
    expect(after?.status).toBe('aborted');
    expect(after?.externalStagedId).toBeNull();
  });

  it('assembles a chunked upload and survives a replayed chunk', async () => {
    if (skipUnlessDb()) return;
    stageInDrive({ chunkMb: 1 });
    const { uploadService, sessionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await makeFolder(alice, 'Chunked');

    const chunkSize = 1024 * 1024;
    const content = Buffer.concat([pdf(''), Buffer.alloc(chunkSize * 2 - 9, 0x41)]);
    expect(content.byteLength).toBe(chunkSize * 2);

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'big.pdf', size: content.byteLength, chunked: true },
      TEST_META,
    );
    expect(ticket.totalChunks).toBe(2);

    await uploadService.receiveChunk(alice, ticket.sessionId, 0, content.subarray(0, chunkSize), TEST_META);
    // The dropped-connection case: the client did not see the acknowledgement and re-sends.
    await uploadService.receiveChunk(alice, ticket.sessionId, 0, content.subarray(0, chunkSize), TEST_META);
    await uploadService.receiveChunk(alice, ticket.sessionId, 1, content.subarray(chunkSize), TEST_META);

    const result = await uploadService.finalize(alice, ticket.sessionId, TEST_META);

    // A replayed chunk must not have been appended twice.
    expect(result.sizeBytes).toBe(content.byteLength);
    expect(result.checksumSha256).toBe(createHash('sha256').update(content).digest('hex'));

    const session = await sessionRepository.findById(ticket.sessionId);
    expect(session?.status).toBe('ready');
    expect(session?.externalUploadUri).toBeNull();
    expect(session?.externalStagedId).toBeNull();
  });

  it('refuses to boot with Drive staging and local content recording', async () => {
    stageInDrive();
    process.env.DEFAULT_STORAGE_PROVIDER = 'local';
    resetEnvCache();

    const { loadEnv } = await import('@/server/config/env');
    // Content staged in Drive is already in Drive; recording it as local would make every
    // subsequent read look for a file on a disk that was never written.
    expect(() => loadEnv()).toThrow(/UPLOAD_STAGING/);
  });
});

/**
 * The HTTP malware-scanning boundary, in the pipeline a Worker actually runs.
 *
 * The property that matters is ordering: the scan happens while the bytes are in the Drive
 * staging folder, and an upload is only promoted — and only gets a version record any download
 * path can resolve — after a `clean` verdict. So an infected or unscannable file must leave no
 * file, no version and nothing in staging.
 */
describe('HTTP malware scanning of Drive-staged uploads', () => {
  const ENDPOINT = 'https://scanner.example/scan';
  const SECRET = 'scan-secret-0123456789';
  let received: { authorization: string | null; body: Buffer }[];

  function scanWith(respond: () => Response | Promise<Response>, options: { failClosed?: boolean } = {}) {
    process.env.MALWARE_SCAN_MODE = 'http';
    process.env.MALWARE_SCAN_ENDPOINT = ENDPOINT;
    process.env.MALWARE_SCAN_SECRET = SECRET;
    process.env.MALWARE_SCAN_TIMEOUT_MS = '2000';
    if (options.failClosed !== undefined) process.env.MALWARE_SCAN_FAIL_CLOSED = String(options.failClosed);
    resetEnvCache();
    received = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit & { body?: ReadableStream<Uint8Array> }) => {
        if (String(input) !== ENDPOINT) throw new Error(`unexpected fetch to ${String(input)}`);
        const chunks: Uint8Array[] = [];
        const reader = init?.body?.getReader();
        for (;;) {
          const next = await reader?.read();
          if (!next || next.done) break;
          chunks.push(next.value);
        }
        received.push({
          authorization: new Headers(init?.headers).get('authorization'),
          body: Buffer.concat(chunks),
        });
        return respond();
      }),
    );
  }

  beforeEach(async () => {
    const { setMalwareScanner } = await import('@/server/security/malware-scanner');
    setMalwareScanner(null);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { setMalwareScanner } = await import('@/server/security/malware-scanner');
    setMalwareScanner(null);
  });

  async function upload(name: string, content: Buffer) {
    const { uploadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await makeFolder(alice, `Scan ${name}`);
    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: name, size: content.byteLength },
      TEST_META,
    );
    await uploadService.receiveStream(alice, ticket.sessionId, Readable.from(content), TEST_META);
    return { finalize: () => uploadService.finalize(alice, ticket.sessionId, TEST_META) };
  }

  async function nothingLeftBehind(name: string) {
    const { FileModel } = await import('@/server/db/models');
    expect(await FileModel.countDocuments({ displayName: name }).setOptions({ withDeleted: true })).toBe(0);
    const staging = drive.snapshot().find((item) => item.name === '.upload-staging');
    const staged = drive.snapshot().filter((item) => staging && item.parents?.includes(staging.id));
    expect(staged, 'nothing may remain in the staging folder').toEqual([]);
  }

  it('sends the exact staged bytes with the shared secret, and stores the file on a clean verdict', async () => {
    if (skipUnlessDb()) return;
    scanWith(() => Response.json({ status: 'clean' }));
    const content = pdf('clean assay export');

    const result = await (await upload('clean.pdf', content)).finalize();

    expect(result.fileId).toBeTruthy();
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe(`Bearer ${SECRET}`);
    expect(received[0]?.body).toEqual(content);
  });

  it('refuses an infected file and leaves no file, version or staged object behind', async () => {
    if (skipUnlessDb()) return;
    scanWith(() => Response.json({ status: 'infected', signature: 'Eicar-Test-Signature' }));

    const pending = await upload('infected.pdf', pdf('X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR'));
    await expect(pending.finalize()).rejects.toThrow(/Malware detected \(Eicar-Test-Signature\)/);
    await nothingLeftBehind('infected.pdf');
  });

  it('refuses when the scanner is unreachable or answers nonsense, when failing closed', async () => {
    if (skipUnlessDb()) return;
    scanWith(() => new Response('upstream exploded', { status: 502 }), { failClosed: true });
    const down = await upload('down.pdf', pdf('scanner down'));
    await expect(down.finalize()).rejects.toThrow(/could not check this file/);
    await nothingLeftBehind('down.pdf');

    scanWith(() => Response.json({ verdict: 'probably fine' }), { failClosed: true });
    const garbled = await upload('garbled.pdf', pdf('garbled'));
    await expect(garbled.finalize()).rejects.toThrow(/could not check this file/);
    await nothingLeftBehind('garbled.pdf');
  });
});
