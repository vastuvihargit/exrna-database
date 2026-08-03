/**
 * Google Drive migration.
 *
 * The controlling requirement is negative: the originals must never be touched. That is
 * asserted twice below — once structurally (the reader the service is given records every
 * call it receives, and nothing but reads ever arrive) and once by source inspection of
 * the live client, which must contain no method capable of a mutating request.
 *
 * The rest is the property every import needs and no import gets for free: running it
 * twice must not produce two copies, a failure must not leave a half-file, and a file
 * that was skipped must be visible as a skip rather than absent from the report.
 */
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { actorFor, seedFixture, TEST_META, type Fixture } from '../helpers/fixtures';
import type { DriveFile, DriveListPage, DriveReader } from '@/server/migration/google-drive-client';

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
    migrationService: (await import('@/server/services/migration.service')).migrationService,
    migrationRepository: await import('@/server/repositories/migration.repository'),
    driveService: (await import('@/server/services/drive.service')).driveService,
    folderService: (await import('@/server/services/folder.service')).folderService,
    fileService: (await import('@/server/services/file.service')).fileService,
    fileRepository: await import('@/server/repositories/file.repository'),
    versionRepository: await import('@/server/repositories/file-version.repository'),
  };
}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');

function pdf(marker: string): Buffer {
  return Buffer.concat([PDF, Buffer.from(`% ${marker}\n`)]);
}

/**
 * A Drive stand-in that records every call.
 *
 * `calls` is the evidence for the "originals are never touched" assertion: if the service
 * ever tried to mutate anything, it would have to go through a method on this object, and
 * there is none.
 */
class StubDrive implements DriveReader {
  readonly calls: string[] = [];

  constructor(
    private readonly tree: Record<string, DriveFile[]>,
    private readonly contents: Record<string, Buffer>,
  ) {}

  async listChildren(folderId: string): Promise<DriveListPage> {
    this.calls.push(`list:${folderId}`);
    return { files: this.tree[folderId] ?? [] };
  }

  async getFile(fileId: string): Promise<DriveFile> {
    this.calls.push(`get:${fileId}`);
    const found = Object.values(this.tree)
      .flat()
      .find((entry) => entry.id === fileId);
    if (!found) throw new Error(`unknown drive file ${fileId}`);
    return found;
  }

  async download(fileId: string): Promise<NodeJS.ReadableStream> {
    this.calls.push(`download:${fileId}`);
    const body = this.contents[fileId];
    if (!body) throw new Error(`no content for ${fileId}`);
    return Readable.from(body);
  }

  async export(fileId: string, mimeType: string): Promise<NodeJS.ReadableStream> {
    this.calls.push(`export:${fileId}:${mimeType}`);
    const body = this.contents[fileId];
    if (!body) throw new Error(`no content for ${fileId}`);
    return Readable.from(body);
  }
}

function driveFile(input: Partial<DriveFile> & { id: string; name: string }): DriveFile {
  return {
    mimeType: 'application/pdf',
    size: '128',
    createdTime: '2024-03-01T10:00:00.000Z',
    modifiedTime: '2024-06-15T09:30:00.000Z',
    trashed: false,
    ...input,
  };
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** A migration into the Molecular Biology department drive, created by an admin. */
async function migrationInto(name: string) {
  const { migrationService, driveService } = await services();
  const admin = await actorFor(fixture.users.companyAdmin);
  const root = await driveService.getDepartmentRoot(admin, fixture.departments.molbio);

  const job = await migrationService.createJob(
    admin,
    { name, targetFolderId: root.id, sourceFolderIds: ['srcroot'] },
    TEST_META,
  );

  // Connecting normally means a Google round trip. The stub reader is injected into the
  // scan and run calls instead, so these tests exercise the import pipeline — the part
  // with the checksums, the deduplication and the folder mapping — without an account.
  const { migrationRepository } = await services();
  const { sealSecret } = await import('@/server/auth/secret-box');
  await migrationRepository.updateJob(job.id, {
    $set: {
      'connection.refreshTokenCipher': sealSecret('test-refresh-token'),
      'connection.accountEmail': 'archive@company.com',
      status: 'connected',
    },
  });

  return { admin, job: (await migrationRepository.findJob(job.id))!, rootFolderId: root.id };
}

describe('the originals are never touched', () => {
  it('only ever reads from Drive during a full scan and import', async () => {
    if (skipUnlessDb()) return;
    const { migrationService } = await services();
    const { admin, job } = await migrationInto('Read-only proof');

    const drive = new StubDrive(
      {
        srcroot: [
          driveFile({ id: 'f1', name: 'protocol.pdf' }),
          driveFile({ id: 'sub', name: 'Raw Data', mimeType: FOLDER_MIME }),
        ],
        sub: [driveFile({ id: 'f2', name: 'run-01.pdf' })],
      },
      { f1: pdf('one'), f2: pdf('two') },
    );

    await migrationService.scan(admin, job.id, TEST_META, drive);
    await migrationService.runImport(admin, job.id, TEST_META, { limit: 10, reader: drive });

    // Every recorded interaction is a read.
    expect(drive.calls.length).toBeGreaterThan(0);
    for (const call of drive.calls) {
      expect(call).toMatch(/^(list|get|download|export):/);
    }
  });

  it('has no method in the live client capable of a mutating request', async () => {
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await fsp.readFile(
      path.resolve(process.cwd(), 'src/server/migration/google-drive-client.ts'),
      'utf8',
    );

    // The one place a request is issued must be a GET, and no other verb may appear.
    for (const verb of ["method: 'POST'", "method: 'PATCH'", "method: 'PUT'", "method: 'DELETE'"]) {
      const usesVerb = source.includes(verb);
      // The token endpoints are POSTs to Google's OAuth service, not to Drive. Those are
      // the only ones permitted, and they never touch a file.
      if (usesVerb) {
        expect(
          source.slice(source.indexOf(verb) - 400, source.indexOf(verb)),
          `${verb} must only appear in the OAuth token exchange, never in a Drive call`,
        ).toContain('TOKEN_ENDPOINT');
      }
    }

    // And the scope requested is read-only.
    expect(source).toContain('drive.readonly');
    expect(source).not.toContain('auth/drive.file');
    expect(source).not.toContain("scope: 'https://www.googleapis.com/auth/drive'");
  });
});

describe('importing', () => {
  it('preserves the folder hierarchy, the dates and the provenance', async () => {
    if (skipUnlessDb()) return;
    const { migrationService, folderService, fileRepository } = await services();
    const { admin, job, rootFolderId } = await migrationInto('Hierarchy');

    const drive = new StubDrive(
      {
        srcroot: [driveFile({ id: 'dir', name: '06_Raw Data', mimeType: FOLDER_MIME })],
        dir: [driveFile({ id: 'deep', name: 'sequencing-run.pdf' })],
      },
      { deep: pdf('deep') },
    );

    await migrationService.scan(admin, job.id, TEST_META, drive);
    const result = await migrationService.runImport(admin, job.id, TEST_META, {
      limit: 10,
      reader: drive,
    });
    expect(result.imported).toBe(1);

    const children = await folderService.listChildFolders(admin, rootFolderId, {
      page: 1,
      pageSize: 50,
      sort: 'name',
      order: 'asc',
    });
    const mirrored = children.items.find((folder) => folder.name === '06_Raw Data');
    expect(mirrored, 'the Drive folder should have been mirrored').toBeTruthy();

    const files = await fileRepository.listInFolder({
      folderId: mirrored!.id,
      visibility: {},
      page: 1,
      pageSize: 10,
      sort: 'displayName',
      order: 'asc',
    });
    expect(files.items).toHaveLength(1);

    const imported = files.items[0]!;
    // Dates come from Drive, not from migration day — otherwise the archive says nothing
    // about when the research happened.
    expect(imported.createdAt.toISOString()).toBe('2024-03-01T10:00:00.000Z');
    // Provenance is on the file itself, so it survives the job record being removed.
    expect(String(imported.metadata.description)).toContain('Google Drive');
    expect(String(imported.metadata.description)).toContain('06_Raw Data/sequencing-run.pdf');
  });

  it('does not import the same file twice when a scan is repeated', async () => {
    if (skipUnlessDb()) return;
    const { migrationService, migrationRepository } = await services();
    const { admin, job } = await migrationInto('Rescan');

    const drive = new StubDrive(
      { srcroot: [driveFile({ id: 'once', name: 'once.pdf' })] },
      { once: pdf('once') },
    );

    await migrationService.scan(admin, job.id, TEST_META, drive);
    const first = await migrationService.runImport(admin, job.id, TEST_META, {
      limit: 10,
      reader: drive,
    });
    expect(first.imported).toBe(1);

    // Re-scan, then run again. The item is already `imported`, so there is nothing to do.
    await migrationService.scan(admin, job.id, TEST_META, drive);
    const second = await migrationService.runImport(admin, job.id, TEST_META, {
      limit: 10,
      reader: drive,
    });
    expect(second.imported).toBe(0);
    expect(second.processed).toBe(0);

    const counts = await migrationRepository.countItemsByStatus(job.id);
    expect(counts.imported).toBe(1);
  });

  it('skips bytes that already exist and says so, rather than storing them again', async () => {
    if (skipUnlessDb()) return;
    const { migrationService, migrationRepository } = await services();
    const { admin, job } = await migrationInto('Duplicates');

    const shared = pdf('identical');
    const drive = new StubDrive(
      {
        srcroot: [
          driveFile({ id: 'a', name: 'report.pdf' }),
          driveFile({ id: 'b', name: 'report FINAL.pdf' }),
        ],
      },
      { a: shared, b: shared },
    );

    await migrationService.scan(admin, job.id, TEST_META, drive);
    const result = await migrationService.runImport(admin, job.id, TEST_META, {
      limit: 10,
      reader: drive,
    });

    expect(result.imported).toBe(1);
    expect(result.skippedDuplicates).toBe(1);

    // The skip is a row in the report, not an omission — and it names what it matched.
    const { items } = await migrationRepository.listItems({
      jobId: job.id,
      status: 'skipped_duplicate',
      page: 1,
      pageSize: 10,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.duplicateOfFileId).toBeTruthy();
  });

  it('rejects a file whose bytes do not match its extension', async () => {
    if (skipUnlessDb()) return;
    const { migrationService, migrationRepository } = await services();
    const { admin, job } = await migrationInto('Signature');

    // A ".pdf" in someone's Drive that is actually a Windows executable.
    const drive = new StubDrive(
      { srcroot: [driveFile({ id: 'evil', name: 'invoice.pdf' })] },
      { evil: Buffer.from('MZ\x90\x00This is not a PDF at all') },
    );

    await migrationService.scan(admin, job.id, TEST_META, drive);
    await migrationService.runImport(admin, job.id, TEST_META, { limit: 10, reader: drive });

    const counts = await migrationRepository.countItemsByStatus(job.id);
    expect(counts.imported ?? 0).toBe(0);
    // Flagged for a human, not silently dropped.
    expect(counts.needs_review).toBe(1);
  });

  it('reports an unsupported file type instead of omitting it', async () => {
    if (skipUnlessDb()) return;
    const { migrationService, migrationRepository } = await services();
    const { admin, job } = await migrationInto('Unsupported');

    const drive = new StubDrive(
      {
        srcroot: [
          driveFile({ id: 'exe', name: 'setup.exe', mimeType: 'application/octet-stream' }),
        ],
      },
      { exe: Buffer.from('MZ binary') },
    );

    await migrationService.scan(admin, job.id, TEST_META, drive);
    const result = await migrationService.runImport(admin, job.id, TEST_META, {
      limit: 10,
      reader: drive,
    });

    expect(result.skippedUnsupported).toBe(1);
    const { items } = await migrationRepository.listItems({
      jobId: job.id,
      status: 'skipped_unsupported',
      page: 1,
      pageSize: 10,
    });
    expect(items[0]!.name).toBe('setup.exe');
    expect(items[0]!.lastError).toBeTruthy();
  });

  it('exports a Google Doc rather than skipping it, and names it with an extension', async () => {
    if (skipUnlessDb()) return;
    const { migrationService, migrationRepository } = await services();
    const { admin, job } = await migrationInto('Google Docs');

    // Word documents are ZIP containers; the signature check expects one.
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('docx body')]);
    const drive = new StubDrive(
      {
        srcroot: [
          driveFile({
            id: 'gdoc',
            name: 'Protocol v3',
            mimeType: 'application/vnd.google-apps.document',
            size: undefined,
          }),
        ],
      },
      { gdoc: docx },
    );

    await migrationService.scan(admin, job.id, TEST_META, drive);
    const result = await migrationService.runImport(admin, job.id, TEST_META, {
      limit: 10,
      reader: drive,
    });

    expect(result.imported).toBe(1);
    expect(drive.calls.some((call) => call.startsWith('export:gdoc'))).toBe(true);

    const { items } = await migrationRepository.listItems({
      jobId: job.id,
      status: 'imported',
      page: 1,
      pageSize: 10,
    });
    expect(items[0]!.resultFileId).toBeTruthy();
  });

  it('retries a failed item without duplicating the ones that succeeded', async () => {
    if (skipUnlessDb()) return;
    const { migrationService, migrationRepository } = await services();
    const { admin, job } = await migrationInto('Retry');

    const contents: Record<string, Buffer> = { good: pdf('good') };
    const drive = new StubDrive(
      {
        srcroot: [
          driveFile({ id: 'good', name: 'good.pdf' }),
          driveFile({ id: 'broken', name: 'broken.pdf' }),
        ],
      },
      contents,
    );

    await migrationService.scan(admin, job.id, TEST_META, drive);
    const first = await migrationService.runImport(admin, job.id, TEST_META, {
      limit: 10,
      reader: drive,
    });
    expect(first.imported).toBe(1);
    expect(first.failed).toBe(1);

    // The source becomes readable, and the failure is requeued.
    contents.broken = pdf('broken');
    const { requeued } = await migrationService.retryFailed(admin, job.id, TEST_META);
    expect(requeued).toBe(1);

    const second = await migrationService.runImport(admin, job.id, TEST_META, {
      limit: 10,
      reader: drive,
    });
    expect(second.imported).toBe(1);

    const counts = await migrationRepository.countItemsByStatus(job.id);
    expect(counts.imported).toBe(2);
    expect(counts.failed ?? 0).toBe(0);
  });

  it('leaves no file record behind when the download fails', async () => {
    if (skipUnlessDb()) return;
    const { migrationService, migrationRepository, fileRepository } = await services();
    const { admin, job, rootFolderId } = await migrationInto('Failed download');

    const drive = new StubDrive(
      { srcroot: [driveFile({ id: 'missing', name: 'ghost.pdf' })] },
      {},
    );

    await migrationService.scan(admin, job.id, TEST_META, drive);
    await migrationService.runImport(admin, job.id, TEST_META, { limit: 10, reader: drive });

    const counts = await migrationRepository.countItemsByStatus(job.id);
    expect(counts.failed).toBe(1);

    // "A failed upload does not create a valid file record" — the same promise, applied
    // to an import.
    const files = await fileRepository.listInFolder({
      folderId: rootFolderId,
      visibility: {},
      page: 1,
      pageSize: 50,
      sort: 'displayName',
      order: 'asc',
    });
    expect(files.items.some((file) => file.displayName === 'ghost.pdf')).toBe(false);
  });
});

describe('who may migrate', () => {
  it('refuses a department head, whose authority stops at their department', async () => {
    if (skipUnlessDb()) return;
    const { migrationService, driveService } = await services();

    const admin = await actorFor(fixture.users.companyAdmin);
    const root = await driveService.getDepartmentRoot(admin, fixture.departments.molbio);
    const head = await actorFor(fixture.users.deptAHead);

    await expect(
      migrationService.createJob(head, { name: 'Nope', targetFolderId: root.id }, TEST_META),
    ).rejects.toMatchObject({ status: 403 });

    await expect(migrationService.listJobs(head)).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a scientist entirely, and does not confirm a job exists', async () => {
    if (skipUnlessDb()) return;
    const { migrationService } = await services();
    const { job } = await migrationInto('Private job');

    const alice = await actorFor(fixture.users.scientistA);
    await expect(migrationService.getJob(alice, job.id)).rejects.toMatchObject({ status: 403 });
  });

  it('never exposes the stored Google credential through a job record', async () => {
    if (skipUnlessDb()) return;
    const { migrationService } = await services();
    const { admin, job } = await migrationInto('Secret handling');

    const fetched = await migrationService.getJob(admin, job.id);
    const serialized = JSON.stringify(fetched);

    expect(serialized).not.toContain('refreshToken');
    expect(serialized).not.toContain('test-refresh-token');
    // What a client is told is a boolean.
    expect(fetched.connection.connected).toBe(true);
  });
});

describe('the sealed-secret box', () => {
  it('round-trips a value and refuses a tampered one', async () => {
    const { sealSecret, openSecret } = await import('@/server/auth/secret-box');

    const sealed = sealSecret('1//refresh-token-value');
    expect(sealed).not.toContain('refresh-token-value');
    expect(openSecret(sealed)).toBe('1//refresh-token-value');

    // Flip a bit in the ciphertext: GCM's tag makes that a decryption failure, not a
    // subtly different plaintext. Flipped at the byte level rather than in the base64
    // text, because the final base64 character can carry padding bits that decode to the
    // same bytes.
    const parts = sealed.split('.');
    const body = Buffer.from(parts[3]!, 'base64url');
    body[0] = body[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], body.toString('base64url')].join('.');

    expect(openSecret(tampered)).toBeNull();
    expect(openSecret('not-a-sealed-value')).toBeNull();
    expect(openSecret(null)).toBeNull();
  });
});
