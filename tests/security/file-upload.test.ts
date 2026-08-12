/**
 * Upload behaviour the brief asks for explicit proof of.
 *
 * The cases here are the ones where being wrong either loses research data or lets
 * something into storage that should never have arrived: a rejected extension, a file
 * whose bytes are not what its name claims, an upload nobody had permission to make, a
 * retried finalization, and a failure part-way through that must leave no usable record.
 *
 * These run against a real in-memory MongoDB and the real local storage provider, because
 * the invariants being tested live in the interaction between the two — a mocked storage
 * layer would prove nothing about whether the bytes and the metadata agree.
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
  // Uploads check disk headroom before accepting bytes, which needs the storage tree to
  // exist — the same call `server/bootstrap.ts` makes on the first request.
  const { getStorageProvider } = await import('@/server/storage');
  await getStorageProvider().ensureReady();
}, 180_000);

afterAll(async () => {
  if (db?.available) await stopTestDb();
});

async function services() {
  return {
    uploadService: (await import('@/server/services/upload.service')).uploadService,
    fileService: (await import('@/server/services/file.service')).fileService,
    folderService: (await import('@/server/services/folder.service')).folderService,
    driveService: (await import('@/server/services/drive.service')).driveService,
    versionRepository: await import('@/server/repositories/file-version.repository'),
    fileRepository: await import('@/server/repositories/file.repository'),
    sessionRepository: await import('@/server/repositories/upload-session.repository'),
    storage: (await import('@/server/storage')).getStorageProvider(),
  };
}

/** A folder in the uploader's own drive, so the test isolates upload rules from ACL rules. */
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

/** The three-step flow a browser performs, condensed. */
async function upload(
  actor: Actor,
  folderId: string,
  filename: string,
  content: Buffer,
  extra: { targetFileId?: string; versionNote?: string } = {},
) {
  const { uploadService } = await services();
  const ticket = await uploadService.authorizeUpload(
    actor,
    { folderId, filename, size: content.byteLength, ...extra },
    TEST_META,
  );
  await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(content), TEST_META);
  const result = await uploadService.finalize(actor, ticket.sessionId, TEST_META);
  return { ticket, result };
}

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from('1 0 obj<</Type/Catalog>>endobj\n%%EOF\n'),
]);

describe('upload authorization', () => {
  it('refuses an extension that is not on the allow-list', async () => {
    if (skipUnlessDb()) return;
    const { uploadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Allow-list');

    await expect(
      uploadService.authorizeUpload(
        alice,
        { folderId, filename: 'installer.exe', size: 1024 },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 415 });
  });

  it('refuses a file with no extension at all', async () => {
    if (skipUnlessDb()) return;
    const { uploadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'No extension');

    await expect(
      uploadService.authorizeUpload(alice, { folderId, filename: 'README', size: 10 }, TEST_META),
    ).rejects.toMatchObject({ status: 415 });
  });

  it('refuses a declared MIME type that contradicts the extension', async () => {
    if (skipUnlessDb()) return;
    const { uploadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Mime mismatch');

    await expect(
      uploadService.authorizeUpload(
        alice,
        {
          folderId,
          filename: 'results.pdf',
          size: 2048,
          mimeType: 'application/x-msdownload',
        },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 415 });
  });

  it('refuses an upload into a folder the employee cannot write to', async () => {
    if (skipUnlessDb()) return;
    const { uploadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB); // other department
    const folderId = await personalFolder(alice, 'Alice only');

    // Reported as missing rather than forbidden: a folder id must not confirm that
    // something exists there.
    await expect(
      uploadService.authorizeUpload(
        bob,
        { folderId, filename: 'intrusion.csv', size: 32 },
        TEST_META,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses an upload larger than the configured maximum', async () => {
    if (skipUnlessDb()) return;
    const { uploadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Too large');

    await expect(
      uploadService.authorizeUpload(
        alice,
        { folderId, filename: 'genome.fastq', size: 100 * 1024 ** 3 },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('gives a colliding name a suffix instead of overwriting the first file', async () => {
    if (skipUnlessDb()) return;
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Name collision');

    const first = await upload(alice, folderId, 'assay.csv', Buffer.from('a,b\n1,2\n'));
    const second = await upload(alice, folderId, 'assay.csv', Buffer.from('a,b\n3,4\n'));

    expect(first.result.displayName).toBe('assay.csv');
    expect(second.result.displayName).not.toBe('assay.csv');
    expect(second.result.fileId).not.toBe(first.result.fileId);
  });
});

describe('what reaches storage', () => {
  it('stores the size and checksum the server measured, not the ones declared', async () => {
    if (skipUnlessDb()) return;
    const { versionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Measured');
    const content = Buffer.from('sample,value\nS-001,42\n');

    const { result } = await upload(alice, folderId, 'measurements.csv', content);
    const version = await versionRepository.findById(result.versionId);

    expect(version?.fileSize).toBe(content.byteLength);
    expect(version?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sizeBytes).toBe(content.byteLength);
  });

  it('rejects an upload whose bytes do not match its extension', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, sessionRepository, fileRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Signature');
    // A Windows executable wearing a .pdf name.
    const disguised = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 0x90)]);

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'protocol.pdf', size: disguised.byteLength },
      TEST_META,
    );
    /**
     * Refused during `receiveStream`, not at finalization.
     *
     * Phase 7 moved the signature check in front of staging: the first 4 KB are buffered and
     * checked before the body is written anywhere, so a mislabelled file never reaches storage
     * at all. The check at finalization still exists and is still the authoritative one — it
     * inspects what was actually stored — but for a single-shot upload this one fires first.
     */
    await expect(
      uploadService.receiveStream(alice, ticket.sessionId, Readable.from(disguised), TEST_META),
    ).rejects.toMatchObject({ status: 415 });

    const session = await sessionRepository.findById(ticket.sessionId);
    expect(session?.status).toBe('rejected');

    // And finalization refuses a session that was rejected for its content.
    await expect(uploadService.finalize(alice, ticket.sessionId, TEST_META)).rejects.toThrow();

    // The whole point: nothing usable was created.
    const names = await fileRepository.takenNamesInFolder(folderId);
    expect(names.has('protocol.pdf')).toBe(false);
  });

  it('rejects a chunked upload whose first chunk does not match its extension', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, sessionRepository, fileRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Chunked signature');
    const disguised = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 0x90)]);

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'chunked.pdf', size: disguised.byteLength, chunked: true },
      TEST_META,
    );

    // The head arrives in chunk zero, so the same refusal is available on this path — and it
    // matters more here, because a chunked upload is a large one.
    await expect(
      uploadService.receiveChunk(alice, ticket.sessionId, 0, disguised, TEST_META),
    ).rejects.toMatchObject({ status: 415 });

    expect((await sessionRepository.findById(ticket.sessionId))?.status).toBe('rejected');
    expect((await fileRepository.takenNamesInFolder(folderId)).has('chunked.pdf')).toBe(false);
  });

  it('does not create a file record when the upload never delivered its bytes', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, fileRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Never sent');

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'abandoned.csv', size: 128 },
      TEST_META,
    );

    await expect(uploadService.finalize(alice, ticket.sessionId, TEST_META)).rejects.toThrow();
    expect((await fileRepository.takenNamesInFolder(folderId)).size).toBe(0);
  });

  it('refuses a stream that exceeds the declared size', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, sessionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Oversized stream');

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'small.txt', size: 8 },
      TEST_META,
    );

    await expect(
      uploadService.receiveStream(alice, ticket.sessionId, Readable.from(Buffer.alloc(4096, 0x41)), TEST_META),
    ).rejects.toThrow();

    const session = await sessionRepository.findById(ticket.sessionId);
    expect(session?.status).toBe('failed');
  });

  it('refuses an upload that stopped short of the declared size', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, fileRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Short upload');

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'truncated.txt', size: 4096 },
      TEST_META,
    );

    // Caught at the point the stream ends, not at finalization: the provider compares
    // what it wrote against what was declared before it reports success.
    await expect(
      uploadService.receiveStream(alice, ticket.sessionId, Readable.from(Buffer.from('short')), TEST_META),
    ).rejects.toThrow();

    await expect(uploadService.finalize(alice, ticket.sessionId, TEST_META)).rejects.toThrow();
    expect((await fileRepository.takenNamesInFolder(folderId)).size).toBe(0);
  });

  it('never exposes a storage key through the file API', async () => {
    if (skipUnlessDb()) return;
    const { fileService } = await services();
    const { toFileDto } = await import('@/server/http/dto');
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'No keys out');

    const { result } = await upload(alice, folderId, 'notes.txt', Buffer.from('hello'));
    const dto = toFileDto(await fileService.getFile(alice, result.fileId));
    const serialized = JSON.stringify(dto);

    expect(serialized).not.toMatch(/storageKey|storageArea|relativeStoragePath|storedFilename/);
    // Nor the physical root, which is what a leaked absolute path would contain.
    expect(serialized).not.toContain('quarantine');
    expect(serialized).not.toContain('originals');
  });
});

describe('finalization is idempotent', () => {
  it('returns the first result instead of creating a second file', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, fileRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Retry');
    const content = Buffer.from('duplicate,finalization\n');

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'retried.csv', size: content.byteLength },
      TEST_META,
    );
    await uploadService.receiveStream(alice, ticket.sessionId, Readable.from(content), TEST_META);

    const first = await uploadService.finalize(alice, ticket.sessionId, TEST_META);
    const second = await uploadService.finalize(alice, ticket.sessionId, TEST_META);

    expect(second.fileId).toBe(first.fileId);
    expect(second.versionId).toBe(first.versionId);
    expect((await fileRepository.takenNamesInFolder(folderId)).size).toBe(1);
  });

  it('treats another employee’s upload session as missing', async () => {
    if (skipUnlessDb()) return;
    const { uploadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);
    const folderId = await personalFolder(alice, 'Session hijack');

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'private.csv', size: 16 },
      TEST_META,
    );

    await expect(
      uploadService.receiveStream(bob, ticket.sessionId, Readable.from(Buffer.alloc(16)), TEST_META),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(uploadService.finalize(bob, ticket.sessionId, TEST_META)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('chunked and resumable uploads', () => {
  it('assembles chunks into one file with the checksum of the whole', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, versionRepository } = await services();
    const { createHash } = await import('crypto');
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Chunked');

    const chunkA = Buffer.alloc(1024, 0x41);
    const chunkB = Buffer.alloc(512, 0x42);
    const whole = Buffer.concat([chunkA, chunkB]);

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'series.txt', size: whole.byteLength, chunked: true },
      TEST_META,
    );
    expect(ticket.chunkSize).toBeGreaterThan(0);

    // One chunk per configured chunk size; this payload is small enough to be one.
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < whole.byteLength; offset += ticket.chunkSize) {
      chunks.push(whole.subarray(offset, Math.min(offset + ticket.chunkSize, whole.byteLength)));
    }
    for (const [index, chunk] of chunks.entries()) {
      await uploadService.receiveChunk(alice, ticket.sessionId, index, chunk, TEST_META);
    }

    const result = await uploadService.finalize(alice, ticket.sessionId, TEST_META);
    const version = await versionRepository.findById(result.versionId);

    expect(version?.fileSize).toBe(whole.byteLength);
    expect(version?.checksumSha256).toBe(createHash('sha256').update(whole).digest('hex'));
  });

  it('does not double-count a re-sent chunk', async () => {
    if (skipUnlessDb()) return;
    const { uploadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Chunk retry');
    const content = Buffer.alloc(256, 0x43);

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'resumed.txt', size: content.byteLength, chunked: true },
      TEST_META,
    );

    await uploadService.receiveChunk(alice, ticket.sessionId, 0, content, TEST_META);
    const again = await uploadService.receiveChunk(alice, ticket.sessionId, 0, content, TEST_META);

    expect(again.receivedChunks).toEqual([0]);
    const result = await uploadService.finalize(alice, ticket.sessionId, TEST_META);
    expect(result.sizeBytes).toBe(content.byteLength);
  });

  it('refuses a chunk index outside the agreed upload', async () => {
    if (skipUnlessDb()) return;
    const { uploadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Chunk bounds');

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'bounded.txt', size: 64, chunked: true },
      TEST_META,
    );

    await expect(
      uploadService.receiveChunk(alice, ticket.sessionId, 99, Buffer.alloc(8), TEST_META),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses to finalize while chunks are still missing', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, sessionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Missing chunks');

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'incomplete.txt', size: 128, chunked: true },
      TEST_META,
    );
    // Pretend the client agreed to more chunks than it sent.
    await sessionRepository.update(ticket.sessionId, { totalChunks: 3 });

    await expect(uploadService.finalize(alice, ticket.sessionId, TEST_META)).rejects.toThrow();
  });
});

describe('versions', () => {
  it('adds a version without replacing the previous one', async () => {
    if (skipUnlessDb()) return;
    const { fileService, versionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Versioning');

    const v1 = await upload(alice, folderId, 'report.pdf', PDF_BYTES);
    const v2 = await upload(
      alice,
      folderId,
      'report.pdf',
      Buffer.concat([PDF_BYTES, Buffer.from('revision two\n')]),
      { targetFileId: v1.result.fileId, versionNote: 'Second pass' },
    );

    expect(v2.result.fileId).toBe(v1.result.fileId);
    expect(v2.result.versionNumber).toBe(2);

    const versions = await fileService.listVersions(alice, v1.result.fileId);
    expect(versions).toHaveLength(2);

    // The first version's bytes are still addressable, under a different storage key.
    const [firstLocation, secondLocation] = await Promise.all([
      versionRepository.getStorageLocation(v1.result.versionId),
      versionRepository.getStorageLocation(v2.result.versionId),
    ]);
    expect(firstLocation).not.toBeNull();
    expect(firstLocation?.key).not.toBe(secondLocation?.key);
  });

  it('keeps the file name when a new version arrives under a different filename', async () => {
    if (skipUnlessDb()) return;
    const { fileService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Version naming');

    const first = await upload(alice, folderId, 'protocol.txt', Buffer.from('v1'));
    await upload(alice, folderId, 'protocol-FINAL-v2.txt', Buffer.from('v2'), {
      targetFileId: first.result.fileId,
    });

    const file = await fileService.getFile(alice, first.result.fileId);
    expect(file.displayName).toBe('protocol.txt');
    expect(file.versionCount).toBe(2);
  });

  it('refuses a new version for a file in a different folder', async () => {
    if (skipUnlessDb()) return;
    const { uploadService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderA = await personalFolder(alice, 'Version folder A');
    const folderB = await personalFolder(alice, 'Version folder B');

    const existing = await upload(alice, folderA, 'in-a.txt', Buffer.from('a'));

    await expect(
      uploadService.authorizeUpload(
        alice,
        {
          folderId: folderB,
          filename: 'in-a.txt',
          size: 1,
          targetFileId: existing.result.fileId,
        },
        TEST_META,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('abandoned uploads', () => {
  it('removes an expired session and its quarantined bytes', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, sessionRepository, storage } = await services();
    const { buildQuarantineKey } = await import('@/server/storage/keys');
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Expiry');
    const content = Buffer.from('never finalized');

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'orphan.txt', size: content.byteLength },
      TEST_META,
    );
    await uploadService.receiveStream(alice, ticket.sessionId, Readable.from(content), TEST_META);

    const quarantine = buildQuarantineKey({ uploadSessionId: ticket.sessionId });
    expect(await storage.fileExists(quarantine.key, quarantine.area)).toBe(true);

    await sessionRepository.update(ticket.sessionId, {
      expiresAt: new Date(Date.now() - 3600_000),
    });

    const { sessions } = await uploadService.cleanupExpired();
    expect(sessions).toBeGreaterThanOrEqual(1);
    expect(await storage.fileExists(quarantine.key, quarantine.area)).toBe(false);
    expect(await sessionRepository.findById(ticket.sessionId)).toBeNull();
  });

  it('refuses more data for an expired session', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, sessionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Expired write');

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'stale.txt', size: 4 },
      TEST_META,
    );
    await sessionRepository.update(ticket.sessionId, {
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      uploadService.receiveStream(alice, ticket.sessionId, Readable.from(Buffer.from('data')), TEST_META),
    ).rejects.toMatchObject({ code: 'UPLOAD_SESSION_EXPIRED' });
  });

  it('discards the bytes when an upload is aborted', async () => {
    if (skipUnlessDb()) return;
    const { uploadService, storage } = await services();
    const { buildQuarantineKey } = await import('@/server/storage/keys');
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Abort');

    const ticket = await uploadService.authorizeUpload(
      alice,
      { folderId, filename: 'cancelled.txt', size: 5 },
      TEST_META,
    );
    await uploadService.receiveStream(alice, ticket.sessionId, Readable.from(Buffer.from('bytes')), TEST_META);

    await uploadService.abort(alice, ticket.sessionId);

    const quarantine = buildQuarantineKey({ uploadSessionId: ticket.sessionId });
    expect(await storage.fileExists(quarantine.key, quarantine.area)).toBe(false);
  });
});

describe('storage accounting', () => {
  it('charges the uploader’s quota and releases it when the file is purged', async () => {
    if (skipUnlessDb()) return;
    const { fileService } = await services();
    const usageRepository = await import('@/server/repositories/storage-usage.repository');
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Quota accounting');
    const content = Buffer.alloc(2048, 0x44);

    const before = await usageRepository.getUserQuota(alice.userId);
    const { result } = await upload(alice, folderId, 'usage.txt', content);
    const after = await usageRepository.getUserQuota(alice.userId);

    expect((after?.usedBytes ?? 0) - (before?.usedBytes ?? 0)).toBe(content.byteLength);

    // Trash then purge: the retention window is what stands between the two, so the test
    // moves the deletion date rather than waiting.
    await fileService.trashFile(alice, result.fileId, TEST_META);
    const { FileModel } = await import('@/server/db/models');
    await FileModel.updateOne(
      { _id: result.fileId },
      { $set: { deletedAt: new Date(Date.now() - 400 * 24 * 3600_000) } },
    )
      .setOptions({ withDeleted: true })
      .exec();

    const purged = await fileService.purgeExpiredTrash();
    expect(purged.files).toBeGreaterThanOrEqual(1);

    const reclaimed = await usageRepository.getUserQuota(alice.userId);
    expect(reclaimed?.usedBytes).toBe(before?.usedBytes ?? 0);
  });

  it('refuses an upload that would exceed the personal quota', async () => {
    if (skipUnlessDb()) return;
    const { uploadService } = await services();
    const userRepository = await import('@/server/repositories/user.repository');
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Quota ceiling');

    const quota = 4096;
    await userRepository.updateById(alice.userId, { storageQuotaBytes: quota });
    try {
      await expect(
        uploadService.authorizeUpload(
          alice,
          { folderId, filename: 'huge.txt', size: quota * 10 },
          TEST_META,
        ),
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    } finally {
      await userRepository.updateById(alice.userId, {
        storageQuotaBytes: 20 * 1024 ** 3,
      });
    }
  });
});
