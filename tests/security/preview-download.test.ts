/**
 * Reading bytes back out: the half of the system where a mistake leaks research data.
 *
 * The brief asks for explicit proof of two things in particular — that a user cannot guess
 * a file id and download it, and that a physical path never reaches the client. Both are
 * here, together with the subtler variant that actually catches people out: passing a
 * *valid* version id belonging to a different file, so permission is checked on one object
 * and bytes are taken from another.
 */
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { actorFor, seedFixture, TEST_META, type Fixture } from '../helpers/fixtures';
import type { Actor } from '@/server/permissions/actor';

let db: TestDb;
let fixture: Fixture;

function skipUnlessDb(): boolean {
  if (db.available) return false;
  expect(db.reason, 'in-memory MongoDB unavailable').toBeTruthy();
  return true;
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

async function services() {
  return {
    downloadService: (await import('@/server/services/download.service')).downloadService,
    uploadService: (await import('@/server/services/upload.service')).uploadService,
    fileService: (await import('@/server/services/file.service')).fileService,
    folderService: (await import('@/server/services/folder.service')).folderService,
    driveService: (await import('@/server/services/drive.service')).driveService,
  };
}

/** Reads a stream to completion — the tests assert on bytes, not on descriptors. */
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
  await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(content));
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

const CSV = Buffer.from('sample,reading\nS-001,1.42\nS-002,1.51\n');

describe('download', () => {
  it('returns the stored bytes with a display filename and no physical location', async () => {
    if (skipUnlessDb()) return;
    const { downloadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Download basics');
    const { fileId } = await uploadInto(alice, folderId, 'readings.csv', CSV);

    const stream = await downloadService.download(alice, fileId, {}, TEST_META);

    expect(await collect(stream.body)).toEqual(CSV);
    expect(stream.contentLength).toBe(CSV.byteLength);
    // Always an attachment with a neutral type, whatever the file claims to be.
    expect(stream.contentDisposition.startsWith('attachment')).toBe(true);
    expect(stream.contentType).toBe('application/octet-stream');
    expect(stream.contentDisposition).toContain('readings.csv');

    const descriptor = JSON.stringify({ ...stream, body: undefined });
    expect(descriptor).not.toMatch(/storageKey|relativeStoragePath|quarantine|originals/);
  });

  it('refuses a file id belonging to another department', async () => {
    if (skipUnlessDb()) return;
    const { downloadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);
    const folderId = await personalFolder(alice, 'IDOR download');
    const { fileId } = await uploadInto(alice, folderId, 'confidential.csv', CSV);

    // The id is real and well-formed; that is the point of the test.
    await expect(downloadService.download(bob, fileId, {}, TEST_META)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a well-formed id that belongs to nothing', async () => {
    if (skipUnlessDb()) return;
    const { downloadService } = await services();
    const { Types } = await import('mongoose');
    const alice = await actorFor(fixture.users.scientistA);

    await expect(
      downloadService.download(alice, String(new Types.ObjectId()), {}, TEST_META),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a version id that belongs to a different file', async () => {
    if (skipUnlessDb()) return;
    const { downloadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const aliceFolder = await personalFolder(alice, 'Version confusion A');
    const bobFolder = await personalFolder(bob, 'Version confusion B');
    const secret = await uploadInto(alice, aliceFolder, 'secret.csv', CSV);
    const own = await uploadInto(bob, bobFolder, 'mine.csv', Buffer.from('a,b\n1,2\n'));

    // Bob may read his own file, and hands it Alice's version id: permission would pass
    // on the file while the bytes came from hers. The ownership check is what stops it.
    await expect(
      downloadService.download(bob, own.fileId, { versionId: secret.versionId }, TEST_META),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('counts the download and records it in the audit log', async () => {
    if (skipUnlessDb()) return;
    const { downloadService, fileService } = await services();
    const auditRepository = await import('@/server/repositories/audit-log.repository');
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Download audit');
    const { fileId } = await uploadInto(alice, folderId, 'audited.csv', CSV);

    const stream = await downloadService.download(alice, fileId, {}, TEST_META);
    await collect(stream.body);

    const file = await fileService.getFile(alice, fileId);
    expect(file.downloadCount).toBe(1);

    const { items } = await auditRepository.query({
      organizationId: alice.organizationId,
      entityId: fileId,
      page: 1,
      pageSize: 20,
    });
    expect(items.some((entry) => entry.action === 'file.download')).toBe(true);
  });

  it('serves an older version without disturbing the current one', async () => {
    if (skipUnlessDb()) return;
    const { downloadService, uploadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Old versions');

    const first = await uploadInto(alice, folderId, 'series.txt', Buffer.from('version one'));
    const secondBytes = Buffer.from('version two');
    const ticket = await uploadService.authorizeUpload(
      alice,
      {
        folderId,
        filename: 'series.txt',
        size: secondBytes.byteLength,
        targetFileId: first.fileId,
      },
      TEST_META,
    );
    await uploadService.receiveStream(alice, ticket.sessionId, Readable.from(secondBytes));
    await uploadService.finalize(alice, ticket.sessionId, TEST_META);

    const old = await downloadService.download(
      alice,
      first.fileId,
      { versionId: first.versionId },
      TEST_META,
    );
    const current = await downloadService.download(alice, first.fileId, {}, TEST_META);

    expect((await collect(old.body)).toString()).toBe('version one');
    expect((await collect(current.body)).toString()).toBe('version two');
  });
});

describe('range requests', () => {
  it('serves a byte range as a partial response', async () => {
    if (skipUnlessDb()) return;
    const { downloadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Ranges');
    const { fileId } = await uploadInto(alice, folderId, 'ranged.txt', Buffer.from('0123456789'));

    const stream = await downloadService.download(
      alice,
      fileId,
      { rangeHeader: 'bytes=2-5' },
      TEST_META,
    );

    expect(stream.range).toEqual({ start: 2, end: 5 });
    expect(stream.contentLength).toBe(4);
    expect(stream.totalSize).toBe(10);
    expect((await collect(stream.body)).toString()).toBe('2345');
  });

  it('serves a suffix range', async () => {
    if (skipUnlessDb()) return;
    const { downloadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Suffix range');
    const { fileId } = await uploadInto(alice, folderId, 'suffix.txt', Buffer.from('0123456789'));

    const stream = await downloadService.download(
      alice,
      fileId,
      { rangeHeader: 'bytes=-3' },
      TEST_META,
    );

    expect((await collect(stream.body)).toString()).toBe('789');
  });

  it('answers 416 for a range beyond the end of the file', async () => {
    if (skipUnlessDb()) return;
    const { downloadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Bad range');
    const { fileId } = await uploadInto(alice, folderId, 'short.txt', Buffer.from('0123456789'));

    await expect(
      downloadService.download(alice, fileId, { rangeHeader: 'bytes=5000-6000' }, TEST_META),
    ).rejects.toMatchObject({ status: 416 });
  });
});

describe('preview', () => {
  it('serves a previewable type inline with its real content type', async () => {
    if (skipUnlessDb()) return;
    const { downloadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Preview inline');
    const { fileId } = await uploadInto(alice, folderId, 'inline.csv', CSV);

    const stream = await downloadService.preview(alice, fileId, {}, TEST_META);

    expect(stream.contentDisposition.startsWith('inline')).toBe(true);
    expect(stream.contentType).toBe('text/csv');
    expect(await collect(stream.body)).toEqual(CSV);
  });

  it('refuses to render a type that has no safe inline renderer', async () => {
    if (skipUnlessDb()) return;
    const { downloadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Preview blocked');
    // A .zip is storable but must never be handed to the browser as a document.
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]);
    const { fileId } = await uploadInto(alice, folderId, 'bundle.zip', zip);

    await expect(downloadService.preview(alice, fileId, {}, TEST_META)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('never previews a script-bearing type inline, even though it is readable text', async () => {
    if (skipUnlessDb()) return;
    const { downloadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Preview forced download');
    const { fileId } = await uploadInto(
      alice,
      folderId,
      'analysis.py',
      Buffer.from('print("hello")\n'),
    );

    // `forceDownload` types are excluded from inline rendering by policy: the browser
    // would execute an SVG or interpret source in this origin.
    await expect(downloadService.preview(alice, fileId, {}, TEST_META)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    const stream = await downloadService.download(alice, fileId, {}, TEST_META);
    expect(stream.contentType).toBe('application/octet-stream');
  });

  it('refuses a preview to an employee who cannot see the file', async () => {
    if (skipUnlessDb()) return;
    const { downloadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);
    const folderId = await personalFolder(alice, 'Preview IDOR');
    const { fileId } = await uploadInto(alice, folderId, 'private.csv', CSV);

    await expect(downloadService.preview(bob, fileId, {}, TEST_META)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('puts a previewed file in the viewer’s recent list and nobody else’s', async () => {
    if (skipUnlessDb()) return;
    const { downloadService, fileService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const head = await actorFor(fixture.users.deptAHead);
    const { driveService, folderService } = await services();

    // A department folder both can reach, so the test isolates "recent" from permission.
    const root = await driveService.getDepartmentRoot(alice, fixture.departments.molbio);
    const folder = await folderService.createFolder(
      alice,
      { name: 'Shared readings', parentFolderId: root.id },
      TEST_META,
    );
    const { fileId } = await uploadInto(alice, folder.id, 'shared.csv', CSV);

    const stream = await downloadService.preview(alice, fileId, {}, TEST_META);
    await collect(stream.body);
    // Recent is written best-effort in the background; give it the microtask it needs.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const aliceRecent = await fileService.listRecent(alice);
    const headRecent = await fileService.listRecent(head);

    expect(aliceRecent.some((file) => file.id === fileId)).toBe(true);
    expect(headRecent.some((file) => file.id === fileId)).toBe(false);
  });
});

describe('deactivated employees', () => {
  it('loses read access to a file they uploaded', async () => {
    if (skipUnlessDb()) return;
    const { downloadService } = await services();
    const userRepository = await import('@/server/repositories/user.repository');
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Deactivation');
    const { fileId } = await uploadInto(alice, folderId, 'leaving.csv', CSV);

    await userRepository.updateById(alice.userId, { $set: { status: 'deactivated' } });
    try {
      // The Actor is rebuilt the way a request would build it, so the status is the one
      // the session lookup would see.
      const deactivated = await actorFor(fixture.users.scientistA);
      expect(deactivated.status).toBe('deactivated');
      await expect(
        downloadService.download(deactivated, fileId, {}, TEST_META),
      ).rejects.toMatchObject({ status: expect.any(Number) });
    } finally {
      await userRepository.updateById(alice.userId, { $set: { status: 'active' } });
    }
  });
});
