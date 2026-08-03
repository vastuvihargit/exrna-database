/**
 * The Google Shared Drive provider, against an in-memory Drive.
 *
 * No network, no Google account, no credentials — which is the Phase 2 acceptance
 * criterion and also the only way this logic gets covered at all. The tests concentrate on
 * the failures that are *silent* in production: a duplicate folder, a corrupt transfer
 * recorded as verified, a locator resolved by the wrong provider, an object left behind in
 * company storage that no database row points at.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';

import { GoogleDriveObjectStore } from '@/server/storage/google/google-drive-object-store';
import { DriveApiError } from '@/server/storage/google/drive-errors';
import type { DriveStorageConfig } from '@/server/storage/google/drive-config';
import type { StorageLocator } from '@/server/storage/types';

import { FakeDriveClient } from '../helpers/fake-drive';

const ROOT = 'root-folder';

function config(overrides: Partial<DriveStorageConfig> = {}): DriveStorageConfig {
  return {
    sharedDriveId: 'drive-company',
    rootFolderId: ROOT,
    serviceAccountEmail: 'drive-storage@example.iam.gserviceaccount.com',
    privateKey: '-----BEGIN PRIVATE KEY-----\nnot-used-by-the-fake\n-----END PRIVATE KEY-----',
    workspaceDomain: 'example.com',
    uploadChunkBytes: 256 * 1024,
    maxConcurrentTransfers: 4,
    requestTimeoutMs: 30_000,
    keySource: 'file',
    ...overrides,
  };
}

let drive: FakeDriveClient;
let store: GoogleDriveObjectStore;

function locatorFor(externalId: string): StorageLocator {
  return { provider: 'google_drive', key: 'originals/ab/cd/object.bin', area: 'originals', externalId };
}

function md5(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

beforeEach(() => {
  drive = new FakeDriveClient();
  store = new GoogleDriveObjectStore(drive, config());
});

describe('GoogleDriveObjectStore — locator handling', () => {
  /**
   * The mirror of `LocalObjectStore`'s refusal, and the same reasoning: falling through to
   * the other provider's addressing does not raise an error a user would ever see. It
   * serves the wrong bytes and calls it a success.
   */
  it('refuses a locator that names another provider', async () => {
    const local: StorageLocator = { provider: 'local', key: 'originals/x', area: 'originals' };
    await expect(store.read(local)).rejects.toThrow(/received a "local" locator/i);
    await expect(store.exists(local)).rejects.toThrow(/received a "local" locator/i);
  });

  /**
   * A record marked as living in Drive with no Drive id is a half-written migration. It
   * must not degrade into reading the retained local copy — that copy is exactly what a
   * verified migration is allowed to delete later, so the read would work today and
   * silently start returning nothing in thirty days.
   */
  it('refuses a Drive locator that carries no Drive file id', async () => {
    const broken: StorageLocator = { provider: 'google_drive', key: 'originals/x', area: 'originals' };
    await expect(store.read(broken)).rejects.toThrow(/carries no Drive file id/i);
  });
});

describe('GoogleDriveObjectStore — reads', () => {
  it('streams stored bytes back unchanged', async () => {
    const content = Buffer.from('sequencing run 42');
    const file = drive.seedFile({ name: 'run42.fastq', parentId: ROOT, content });

    const body = await store.read(locatorFor(file.id));
    expect(await collect(body)).toEqual(content);
  });

  /** Range reads are what make audio and video previews seekable; they must survive the move. */
  it('honours a byte range', async () => {
    const content = Buffer.from('0123456789');
    const file = drive.seedFile({ name: 'nums.bin', parentId: ROOT, content });

    expect(await collect(await store.read(locatorFor(file.id), { range: { start: 2, end: 5 } }))).toEqual(
      Buffer.from('2345'),
    );
    // An open-ended range reads to the end.
    expect(await collect(await store.read(locatorFor(file.id), { range: { start: 7 } }))).toEqual(
      Buffer.from('789'),
    );
  });

  it('reports a missing object as absent rather than throwing', async () => {
    expect(await store.exists(locatorFor('no-such-id'))).toBe(false);
    expect(await store.itemExists('no-such-id')).toBe(false);
  });

  /**
   * A 403 or a 500 is *not* "the file is gone". Reporting it as absent would let the
   * integrity sweep conclude that content had been deleted and flag it for an administrator
   * during a routine Google outage.
   */
  it('propagates a non-404 failure from an existence check', async () => {
    drive.failNext('getFile', new DriveApiError({ status: 500, message: 'Backend Error' }));
    await expect(store.exists(locatorFor('anything'))).rejects.toThrow(/Backend Error/);
  });

  it('reports metadata with the revision as the etag', async () => {
    const content = Buffer.from('report');
    const file = drive.seedFile({ name: 'r.pdf', parentId: ROOT, content, mimeType: 'application/pdf' });

    const metadata = await store.metadata(locatorFor(file.id));
    expect(metadata.size).toBe(content.length);
    expect(metadata.contentType).toBe('application/pdf');
    // Not the MD5: this is what an approval binds to, and a Google-native document has a
    // revision but never an MD5.
    expect(metadata.etag).toBe(file.headRevisionId);
  });

  /** Deletion is idempotent everywhere in this codebase; Drive is not an exception. */
  it('treats removing an already-absent object as success', async () => {
    await expect(store.remove(locatorFor('never-existed'))).resolves.toBeUndefined();
  });
});

describe('GoogleDriveObjectStore — Google-native documents', () => {
  it('explains that a native document has no bytes instead of surfacing a raw 403', async () => {
    const doc = drive.seedNativeDocument({ name: 'Protocol', parentId: ROOT });

    await expect(store.read(locatorFor(doc.id))).rejects.toThrow(/Google-native document/i);
  });

  it('exports a native document to a chosen format', async () => {
    const doc = drive.seedNativeDocument({ name: 'Protocol', parentId: ROOT, kind: 'spreadsheet' });

    const body = await store.exportNative(locatorFor(doc.id), 'text/csv');
    expect((await collect(body)).toString()).toContain('text/csv');
    expect(await store.isGoogleNative(locatorFor(doc.id))).toBe(true);
  });
});

describe('GoogleDriveObjectStore — uploads', () => {
  it('stores the bytes and reports both digests it measured', async () => {
    const content = Buffer.from('raw research dataset');

    const stored = await store.put({
      target: {
        key: 'originals/aa/bb/v1.bin',
        area: 'originals',
        externalParentId: ROOT,
        displayName: 'dataset.csv',
        contentType: 'text/csv',
      },
      body: Readable.from([content]),
      size: content.length,
    });

    expect(stored.provider).toBe('google_drive');
    expect(stored.size).toBe(content.length);
    expect(stored.checksumMd5).toBe(md5(content));
    expect(stored.checksumSha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(stored.externalId).toBeTruthy();
    expect(drive.contentOf(stored.externalId!)).toEqual(content);
    // The application's own key travels with the record; it is what makes a rollback to
    // local storage a field flip rather than a data migration.
    expect(stored.key).toBe('originals/aa/bb/v1.bin');
  });

  /**
   * The single most important upload test. If a transfer can corrupt bytes and still be
   * recorded as verified, every later guarantee in this migration is worthless — and the
   * local copy it authorises deleting is the only other copy.
   */
  it('fails and removes the remote object when the sent bytes do not match the expected checksum', async () => {
    const content = Buffer.from('the real bytes');

    await expect(
      store.put({
        target: { key: 'originals/x', area: 'originals', externalParentId: ROOT, displayName: 'x.bin' },
        body: Readable.from([content]),
        size: content.length,
        expectedMd5: md5(Buffer.from('what the database thinks is here')),
      }),
    ).rejects.toThrow(/did not match the checksum/i);

    // Nothing may be left behind: an object at a real Drive id that no row points at and no
    // verification passed is exactly what the reconciliation queue exists to prevent.
    expect(drive.snapshot()).toHaveLength(0);
  });

  it('fails when the stream carries a different number of bytes than declared', async () => {
    await expect(
      store.put({
        target: { key: 'originals/y', area: 'originals', externalParentId: ROOT, displayName: 'y.bin' },
        body: Readable.from([Buffer.from('four')]),
        size: 999,
      }),
    ).rejects.toThrow();
  });

  it('surfaces a failure on the source stream rather than hanging', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('disk read failed'));
      },
    });

    await expect(
      store.put({
        target: { key: 'originals/z', area: 'originals', externalParentId: ROOT, displayName: 'z.bin' },
        body: failing,
      }),
    ).rejects.toThrow();
  });

  it('writes to the configured root when no parent is given', async () => {
    const content = Buffer.from('x');
    const stored = await store.put({
      target: { key: 'originals/q', area: 'originals', displayName: 'q.bin' },
      body: Readable.from([content]),
      size: 1,
    });

    expect(drive.snapshot().find((item) => item.id === stored.externalId)?.parents).toEqual([ROOT]);
  });

  it('carries provider-native properties onto the stored object', async () => {
    const content = Buffer.from('x');
    const stored = await store.put({
      target: { key: 'originals/k', area: 'originals', externalParentId: ROOT, displayName: 'k.bin' },
      body: Readable.from([content]),
      size: 1,
      properties: { idempotencyKey: 'job-7:version-3' },
    });

    const remote = await drive.getFile(stored.externalId!);
    expect(remote.appProperties?.idempotencyKey).toBe('job-7:version-3');
  });
});

describe('GoogleDriveObjectStore — folder mirroring', () => {
  it('creates a folder and stamps it with the application folder id', async () => {
    const result = await store.ensureFolder({ name: 'Project Ares', parentExternalId: ROOT, appFolderId: 'folder-1' });

    expect(result.externalParentId).toBe(ROOT);
    const remote = await drive.getFile(result.externalId);
    expect(remote.appProperties?.appFolderId).toBe('folder-1');
  });

  /**
   * Idempotency, and the reason it exists: a crash between "Drive created the folder" and
   * "MongoDB recorded its id" leaves an orphan. Without adoption, every retry adds another
   * copy of the same folder to the Shared Drive.
   */
  it('adopts an orphaned folder instead of creating a second one', async () => {
    const orphan = drive.seedFolder({ name: 'Project Ares', parentId: ROOT, appFolderId: 'folder-1' });

    const result = await store.ensureFolder({ name: 'Project Ares', parentExternalId: ROOT, appFolderId: 'folder-1' });

    expect(result.externalId).toBe(orphan.id);
    expect(drive.calls).not.toContain('createFolder');
    expect(drive.snapshot().filter((item) => item.name === 'Project Ares')).toHaveLength(1);
  });

  it('is idempotent across repeated calls', async () => {
    const first = await store.ensureFolder({ name: 'Assays', parentExternalId: ROOT, appFolderId: 'folder-2' });
    const second = await store.ensureFolder({ name: 'Assays', parentExternalId: ROOT, appFolderId: 'folder-2' });

    expect(second.externalId).toBe(first.externalId);
    expect(drive.snapshot().filter((item) => item.name === 'Assays')).toHaveLength(1);
  });

  /**
   * Never by name. Two sibling folders may legitimately share a name in Drive, and a name
   * match would happily write research data into a folder somebody created by hand for
   * something else entirely.
   */
  it('does not adopt a folder that merely has the same name', async () => {
    const handMade = drive.seedFolder({ name: 'Assays', parentId: ROOT });

    const result = await store.ensureFolder({ name: 'Assays', parentExternalId: ROOT, appFolderId: 'folder-3' });

    expect(result.externalId).not.toBe(handMade.id);
    expect(drive.snapshot().filter((item) => item.name === 'Assays')).toHaveLength(2);
  });

  /** A stamped folder that has been moved elsewhere is not dragged back by an adoption. */
  it('scopes adoption to the intended parent', async () => {
    const other = drive.seedFolder({ name: 'Elsewhere', parentId: ROOT });
    drive.seedFolder({ name: 'Assays', parentId: other.id, appFolderId: 'folder-4' });

    const result = await store.ensureFolder({ name: 'Assays', parentExternalId: ROOT, appFolderId: 'folder-4' });

    const created = drive.snapshot().find((item) => item.id === result.externalId);
    expect(created?.parents).toEqual([ROOT]);
  });

  it('falls back to the configured root when no parent is given', async () => {
    const result = await store.ensureFolder({ name: 'Top', parentExternalId: null, appFolderId: 'folder-5' });
    expect(result.externalParentId).toBe(ROOT);
  });
});

describe('GoogleDriveObjectStore — mutations', () => {
  it('renames an item', async () => {
    const file = drive.seedFile({ name: 'old.txt', parentId: ROOT, content: Buffer.from('x') });
    await store.renameItem(file.id, 'new.txt');
    expect((await drive.getFile(file.id)).name).toBe('new.txt');
  });

  /**
   * Drive models a move as add-parent plus remove-parent, and an item can hold several
   * parents. Removing the wrong one — or none — leaves the file visible in both places,
   * which is how a "moved" confidential file stays in the folder it was moved out of.
   */
  it('moves an item out of its old parent, not just into the new one', async () => {
    const source = drive.seedFolder({ name: 'From', parentId: ROOT });
    const target = drive.seedFolder({ name: 'To', parentId: ROOT });
    const file = drive.seedFile({ name: 'f.bin', parentId: source.id, content: Buffer.from('x') });

    await store.moveItem(file.id, target.id);

    expect((await drive.getFile(file.id)).parents).toEqual([target.id]);
  });

  it('uses the caller-supplied old parent without re-reading the item', async () => {
    const source = drive.seedFolder({ name: 'From', parentId: ROOT });
    const target = drive.seedFolder({ name: 'To', parentId: ROOT });
    const file = drive.seedFile({ name: 'f.bin', parentId: source.id, content: Buffer.from('x') });
    drive.calls.length = 0;

    await store.moveItem(file.id, target.id, source.id);

    expect(drive.calls).not.toContain('getFile');
    expect((await drive.getFile(file.id)).parents).toEqual([target.id]);
  });

  it('does nothing when the item is already in the destination', async () => {
    const target = drive.seedFolder({ name: 'To', parentId: ROOT });
    const file = drive.seedFile({ name: 'f.bin', parentId: target.id, content: Buffer.from('x') });
    drive.calls.length = 0;

    await store.moveItem(file.id, target.id, target.id);

    expect(drive.calls).not.toContain('updateFile');
  });

  it('trashes and restores an item, preserving it either way', async () => {
    const file = drive.seedFile({ name: 'f.bin', parentId: ROOT, content: Buffer.from('keep me') });

    await store.trashItem(file.id);
    expect((await drive.getFile(file.id)).trashed).toBe(true);
    // Trashing is recoverable: the bytes are still there.
    expect(drive.contentOf(file.id)).toEqual(Buffer.from('keep me'));

    await store.restoreItem(file.id);
    expect((await drive.getFile(file.id)).trashed).toBe(false);
  });

  it('copies server-side and reports what Drive actually created', async () => {
    const content = Buffer.from('original bytes');
    const source = drive.seedFile({ name: 'a.bin', parentId: ROOT, content });
    const target = drive.seedFolder({ name: 'Copies', parentId: ROOT });

    const copied = await store.copy(locatorFor(source.id), {
      key: 'originals/copy',
      area: 'originals',
      externalParentId: target.id,
      displayName: 'a (copy).bin',
    });

    expect(copied.externalId).not.toBe(source.id);
    expect(copied.size).toBe(content.length);
    expect(copied.checksumMd5).toBe(md5(content));
    expect(drive.contentOf(copied.externalId!)).toEqual(content);
  });
});
