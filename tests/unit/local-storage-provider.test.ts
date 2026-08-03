import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { LocalStorageProvider } from '@/server/storage/local-provider';

let root: string;
let provider: LocalStorageProvider;

function streamOf(payload: Buffer | string): Readable {
  return Readable.from([Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]);
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

beforeEach(async () => {
  root = path.join(os.tmpdir(), `biotech-storage-${randomUUID()}`);
  provider = new LocalStorageProvider({
    storage: path.join(root, 'storage'),
    temp: path.join(root, 'temp'),
    quarantine: path.join(root, 'quarantine'),
    previews: path.join(root, 'previews'),
    exports: path.join(root, 'exports'),
  });
  await provider.ensureReady();
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('LocalStorageProvider — write', () => {
  it('stores a file and reports the measured size and checksum', async () => {
    const payload = Buffer.from('experiment results v1');
    const result = await provider.saveFile({ key: 'org/dept/file/v1', area: 'originals', body: streamOf(payload) });

    expect(result.size).toBe(payload.byteLength);
    expect(result.checksumSha256).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(await provider.fileExists('org/dept/file/v1', 'originals')).toBe(true);
  });

  // Rule 15 in docs/phase-0/04-storage.md: a stored version is immutable.
  it('refuses to overwrite an existing key', async () => {
    await provider.saveFile({ key: 'org/dept/file/v1', area: 'originals', body: streamOf('first') });
    await expect(
      provider.saveFile({ key: 'org/dept/file/v1', area: 'originals', body: streamOf('second') }),
    ).rejects.toThrow();

    // The original bytes are untouched.
    expect((await collect(await provider.getFile('org/dept/file/v1', 'originals'))).toString()).toBe('first');
  });

  it('aborts and removes the partial file when the stream exceeds the declared size', async () => {
    await expect(
      provider.saveFile({
        key: 'org/dept/file/v2',
        area: 'originals',
        body: streamOf(Buffer.alloc(100)),
        expectedSize: 10,
      }),
    ).rejects.toThrow();

    // A failed upload must not leave a usable file behind.
    expect(await provider.fileExists('org/dept/file/v2', 'originals')).toBe(false);
  });

  it('rejects and cleans up a truncated upload', async () => {
    await expect(
      provider.saveFile({
        key: 'org/dept/file/v3',
        area: 'originals',
        body: streamOf(Buffer.alloc(10)),
        expectedSize: 100,
      }),
    ).rejects.toThrow(/Incomplete upload/);
    expect(await provider.fileExists('org/dept/file/v3', 'originals')).toBe(false);
  });

  it('cleans up when the source stream errors mid-transfer', async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('network dropped'));
      },
    });

    await expect(provider.saveFile({ key: 'org/dept/file/v4', area: 'originals', body: failing })).rejects.toThrow();
    expect(await provider.fileExists('org/dept/file/v4', 'originals')).toBe(false);
  });

  it('never writes outside its area root', async () => {
    await expect(
      provider.saveFile({ key: '../../escape', area: 'originals', body: streamOf('x') }),
    ).rejects.toThrow();
    await expect(
      provider.saveFile({ key: '/etc/passwd', area: 'originals', body: streamOf('x') }),
    ).rejects.toThrow();
    // Nothing was created anywhere near the root.
    await expect(fsp.stat(path.join(root, 'escape'))).rejects.toThrow();
  });

  it('handles a large payload without buffering it in memory', async () => {
    // 32 MB streamed in 1 MB chunks; heap growth stays far below the payload size.
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const total = 32;
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < total; i += 1) yield chunk;
      })(),
    );

    const before = process.memoryUsage().heapUsed;
    const result = await provider.saveFile({ key: 'org/dept/big/v1', area: 'originals', body: source });
    const growth = process.memoryUsage().heapUsed - before;

    expect(result.size).toBe(total * chunk.byteLength);
    expect(growth).toBeLessThan(result.size / 2);
  });
});

describe('LocalStorageProvider — read', () => {
  it('streams stored bytes back unchanged', async () => {
    const payload = Buffer.from('spectral data');
    await provider.saveFile({ key: 'org/dept/file/v1', area: 'originals', body: streamOf(payload) });
    expect(await collect(await provider.getFile('org/dept/file/v1', 'originals'))).toEqual(payload);
  });

  it('supports byte ranges for media playback', async () => {
    await provider.saveFile({ key: 'org/dept/file/v1', area: 'originals', body: streamOf('0123456789') });
    const partial = await collect(await provider.getFile('org/dept/file/v1', 'originals', { range: { start: 2, end: 5 } }));
    expect(partial.toString()).toBe('2345');
  });

  it('rejects an out-of-bounds range', async () => {
    await provider.saveFile({ key: 'org/dept/file/v1', area: 'originals', body: streamOf('short') });
    await expect(provider.getFile('org/dept/file/v1', 'originals', { range: { start: 0, end: 999 } })).rejects.toThrow();
  });

  it('fails cleanly for a missing key', async () => {
    await expect(provider.getFile('org/dept/missing/v1', 'originals')).rejects.toThrow();
    expect(await provider.fileExists('org/dept/missing/v1', 'originals')).toBe(false);
  });

  it('refuses traversal on every read path', async () => {
    await expect(provider.getFile('../../../etc/passwd', 'originals')).rejects.toThrow();
    await expect(provider.getFileMetadata('../secret', 'originals')).rejects.toThrow();
    await expect(provider.fileExists('..', 'originals')).rejects.toThrow();
  });
});

describe('LocalStorageProvider — move, copy, delete', () => {
  it('moves quarantined bytes into permanent storage', async () => {
    await provider.saveFile({ key: 'session1/assembled', area: 'quarantine', body: streamOf('promoted') });
    await provider.moveFile(
      { key: 'session1/assembled', area: 'quarantine' },
      { key: 'org/dept/file/v1', area: 'originals' },
    );

    expect(await provider.fileExists('session1/assembled', 'quarantine')).toBe(false);
    expect((await collect(await provider.getFile('org/dept/file/v1', 'originals'))).toString()).toBe('promoted');
  });

  it('refuses to move onto an existing destination', async () => {
    await provider.saveFile({ key: 'session2/assembled', area: 'quarantine', body: streamOf('a') });
    await provider.saveFile({ key: 'org/dept/file/v1', area: 'originals', body: streamOf('existing') });

    await expect(
      provider.moveFile({ key: 'session2/assembled', area: 'quarantine' }, { key: 'org/dept/file/v1', area: 'originals' }),
    ).rejects.toThrow();
    expect((await collect(await provider.getFile('org/dept/file/v1', 'originals'))).toString()).toBe('existing');
  });

  it('copies bytes for version restore without touching the source', async () => {
    await provider.saveFile({ key: 'org/dept/file/v1', area: 'originals', body: streamOf('original version') });
    await provider.copyFile(
      { key: 'org/dept/file/v1', area: 'originals' },
      { key: 'org/dept/file/v9', area: 'originals' },
    );

    expect((await collect(await provider.getFile('org/dept/file/v1', 'originals'))).toString()).toBe('original version');
    expect((await collect(await provider.getFile('org/dept/file/v9', 'originals'))).toString()).toBe('original version');
  });

  it('treats deleting a missing file as success', async () => {
    await expect(provider.deleteFile('org/dept/nothing/v1', 'quarantine')).resolves.toBeUndefined();
  });

  it('removes an entire session directory', async () => {
    await provider.saveFile({ key: 'session3/part-000000', area: 'temporary', body: streamOf('a') });
    await provider.saveFile({ key: 'session3/part-000001', area: 'temporary', body: streamOf('b') });

    await provider.deleteDirectory('session3', 'temporary');
    expect(await provider.fileExists('session3/part-000000', 'temporary')).toBe(false);
  });
});

describe('LocalStorageProvider — chunked writes', () => {
  it('assembles chunks and reports the combined checksum', async () => {
    const handle = await provider.createWriteStream('session4/assembled', 'quarantine');
    await handle.write(Buffer.from('chunk-one;'));
    await handle.write(Buffer.from('chunk-two'));
    const result = await handle.commit();

    const expected = Buffer.from('chunk-one;chunk-two');
    expect(result.size).toBe(expected.byteLength);
    expect(result.checksumSha256).toBe(createHash('sha256').update(expected).digest('hex'));
    expect((await collect(await provider.getFile('session4/assembled', 'quarantine'))).toString()).toBe(expected.toString());
  });

  it('leaves nothing behind when a chunked upload is aborted', async () => {
    const handle = await provider.createWriteStream('session5/assembled', 'quarantine');
    await handle.write(Buffer.from('partial'));
    await handle.abort();
    expect(await provider.fileExists('session5/assembled', 'quarantine')).toBe(false);
  });
});

describe('LocalStorageProvider — capacity', () => {
  it('reports usable capacity for the health check', async () => {
    const capacity = await provider.getCapacity('originals');
    expect(capacity.totalBytes).toBeGreaterThan(0);
    expect(capacity.freeBytes).toBeGreaterThanOrEqual(0);
    expect(capacity.freeBytes).toBeLessThanOrEqual(capacity.totalBytes);
  });
});
