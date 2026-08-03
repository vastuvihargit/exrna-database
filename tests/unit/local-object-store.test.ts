/**
 * The local `ObjectStore` adapter, exercised against a real LocalStorageProvider on a
 * temporary directory.
 *
 * The adapter is thin on purpose, so these tests are mostly about the two things a thin
 * adapter can still get wrong: losing a guarantee in translation, and answering for a
 * locator that belongs to somebody else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { LocalStorageProvider } from '@/server/storage/local-provider';
import { LocalObjectStore } from '@/server/storage/local-object-store';
import type { HierarchicalStorageProvider, StorageLocator } from '@/server/storage/types';

let root: string;
let files: LocalStorageProvider;
let store: LocalObjectStore;

function localLocator(key: string, area: StorageLocator['area'] = 'originals'): StorageLocator {
  return { provider: 'local', key, area };
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

beforeEach(async () => {
  root = path.join(os.tmpdir(), `biotech-object-store-${randomUUID()}`);
  files = new LocalStorageProvider({
    storage: path.join(root, 'storage'),
    temp: path.join(root, 'temp'),
    quarantine: path.join(root, 'quarantine'),
    previews: path.join(root, 'previews'),
    exports: path.join(root, 'exports'),
  });
  await files.ensureReady();
  store = new LocalObjectStore(files);

  await files.saveFile({
    key: 'org/dept/file/v1',
    area: 'originals',
    body: Readable.from([Buffer.from('assay results')]),
  });
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('LocalObjectStore — reads', () => {
  it('streams stored bytes for a local locator', async () => {
    const body = await store.read(localLocator('org/dept/file/v1'));
    expect((await collect(body)).toString()).toBe('assay results');
  });

  it('passes byte ranges through to the provider', async () => {
    const body = await store.read(localLocator('org/dept/file/v1'), { range: { start: 0, end: 4 } });
    expect((await collect(body)).toString()).toBe('assay');
  });

  it('reports existence and metadata', async () => {
    expect(await store.exists(localLocator('org/dept/file/v1'))).toBe(true);
    expect(await store.exists(localLocator('org/dept/file/missing'))).toBe(false);

    const metadata = await store.metadata(localLocator('org/dept/file/v1'));
    expect(metadata.size).toBe('assay results'.length);
  });

  /**
   * The guarantee that must survive the extra layer: a key cannot escape its area root.
   * If the adapter had normalized or joined the key itself this would silently pass.
   */
  it('still refuses path traversal', async () => {
    await expect(store.read(localLocator('../../../etc/passwd'))).rejects.toThrow();
    await expect(store.metadata(localLocator('../secret'))).rejects.toThrow();
    await expect(store.exists(localLocator('..'))).rejects.toThrow();
  });
});

/**
 * The failure this prevents is specific and nasty: after migration a version's local copy
 * is deliberately retained, so a Drive locator misrouted to the local store would find a
 * real file at `locator.key` and serve it. That is a stale download reported as a success,
 * which is worse than an error.
 */
describe('LocalObjectStore — provider mismatch', () => {
  it('refuses a locator belonging to another provider rather than reading the local key', async () => {
    const drive: StorageLocator = {
      provider: 'google_drive',
      key: 'org/dept/file/v1', // a real, readable local key
      area: 'originals',
      externalId: 'drive-abc',
    };

    await expect(store.read(drive)).rejects.toThrow(/google_drive/);
    await expect(store.exists(drive)).rejects.toThrow(/google_drive/);
    await expect(store.metadata(drive)).rejects.toThrow(/google_drive/);
    await expect(store.remove(drive)).rejects.toThrow(/google_drive/);

    // And the local file it was pointing at is untouched.
    expect(await files.fileExists('org/dept/file/v1', 'originals')).toBe(true);
  });
});

describe('LocalObjectStore — copy and remove', () => {
  it('copies without touching the source and reports the written size', async () => {
    const result = await store.copy(localLocator('org/dept/file/v1'), {
      key: 'org/dept/file/v2',
      area: 'originals',
    });

    expect(result.provider).toBe('local');
    expect(result.key).toBe('org/dept/file/v2');
    expect(result.size).toBe('assay results'.length);
    // Not re-hashed: reporting an unverified digest would be a claim nothing checked.
    expect(result.checksumSha256).toBeUndefined();
    expect(result.externalId).toBeUndefined();

    expect((await collect(await store.read(localLocator('org/dept/file/v1')))).toString()).toBe('assay results');
    expect((await collect(await store.read(localLocator('org/dept/file/v2')))).toString()).toBe('assay results');
  });

  it('refuses to copy onto an existing key', async () => {
    await store.copy(localLocator('org/dept/file/v1'), { key: 'org/dept/file/v2', area: 'originals' });
    await expect(
      store.copy(localLocator('org/dept/file/v1'), { key: 'org/dept/file/v2', area: 'originals' }),
    ).rejects.toThrow();
  });

  it('removes an object, and treats a missing one as success', async () => {
    await store.remove(localLocator('org/dept/file/v1'));
    expect(await files.fileExists('org/dept/file/v1', 'originals')).toBe(false);
    await expect(store.remove(localLocator('org/dept/file/v1'))).resolves.toBeUndefined();
  });
});

/**
 * Local folders exist only as MongoDB rows — storage keys are flat generated identifiers
 * and never mirror the user's hierarchy. These methods answering successfully without
 * doing anything is the truthful result for this provider, and it is what lets the folder
 * services call them unconditionally in Phase 7 instead of branching on the provider name.
 */
describe('LocalObjectStore — folder mirroring is a no-op', () => {
  // Exercised through the interface rather than the class, so this also asserts that
  // LocalObjectStore satisfies the contract Phase 7's folder services will call.
  const asHierarchy = (): HierarchicalStorageProvider => store;

  it('reports no folder object to record', async () => {
    const result = await asHierarchy().ensureFolder({
      name: 'Protocols',
      parentExternalId: null,
      appFolderId: '65f000000000000000000001',
    });
    expect(result).toBeNull();
  });

  it('accepts every mutation without error and creates nothing on disk', async () => {
    const hierarchy = asHierarchy();
    await expect(hierarchy.renameItem('x', 'y')).resolves.toBeUndefined();
    await expect(hierarchy.moveItem('x', 'parent')).resolves.toBeUndefined();
    await expect(hierarchy.trashItem('x')).resolves.toBeUndefined();
    await expect(hierarchy.restoreItem('x')).resolves.toBeUndefined();
    await expect(hierarchy.deleteItem('x')).resolves.toBeUndefined();

    // No external ids exist locally, so nothing can be found by one. Answering `true`
    // would let a reconciliation sweep conclude a nonexistent remote object is present.
    expect(await hierarchy.itemExists('x')).toBe(false);
  });
});
