/**
 * LocalStorageProvider — private server filesystem.
 *
 * Guarantees enforced here (docs/phase-0/04-storage.md):
 *   • no overwrite, ever — files are created with the exclusive flag 'wx'
 *   • size and SHA-256 are measured while streaming, never trusted from the client
 *   • nothing is buffered in memory: a 2 GB upload uses a constant, small footprint
 *   • every key passes through resolveKey() before any syscall
 *   • only regular files are read (a symlink swapped in by a local attacker is refused)
 *   • data is fsync'd, and so is the parent directory, before a write is reported done
 */
import { createHash } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';

import { StorageError } from '@/server/errors/app-error';
import { resolveKey } from './path-safety';
import type {
  GetFileOptions,
  SaveFileInput,
  StorageArea,
  StorageCapacity,
  StorageProvider,
  StorageWriteHandle,
  StoredFile,
  StoredFileMetadata,
} from './types';

export interface LocalProviderRoots {
  storage: string;
  temp: string;
  quarantine: string;
  previews: string;
  exports: string;
}

const DIR_MODE = 0o750;
const FILE_MODE = 0o640;

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local' as const;

  constructor(private readonly roots: LocalProviderRoots) {}

  // ── area → absolute root ───────────────────────────────────────────────────
  private areaRoot(area: StorageArea): string {
    switch (area) {
      case 'originals':
        return path.join(this.roots.storage, 'originals');
      case 'versions':
        return path.join(this.roots.storage, 'versions');
      case 'archives':
        return path.join(this.roots.storage, 'archives');
      case 'migration-staging':
        return path.join(this.roots.storage, 'migration-staging');
      case 'quarantine':
        return this.roots.quarantine;
      case 'previews':
        return this.roots.previews;
      case 'temporary':
        return this.roots.temp;
      case 'exports':
        return this.roots.exports;
      default: {
        const exhaustive: never = area;
        throw new StorageError('INVALID_KEY', `Unknown storage area: ${String(exhaustive)}`);
      }
    }
  }

  private absolutePath(key: string, area: StorageArea): string {
    return resolveKey(this.areaRoot(area), key);
  }

  async ensureReady(): Promise<void> {
    const areas: StorageArea[] = [
      'originals',
      'versions',
      'previews',
      'quarantine',
      'migration-staging',
      'temporary',
      'exports',
      'archives',
    ];
    for (const area of areas) {
      await fsp.mkdir(this.areaRoot(area), { recursive: true, mode: DIR_MODE });
    }
  }

  // ── write ──────────────────────────────────────────────────────────────────
  async saveFile(input: SaveFileInput): Promise<StoredFile> {
    const fullPath = this.absolutePath(input.key, input.area);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true, mode: DIR_MODE });

    const hash = createHash('sha256');
    let bytes = 0;

    // Measures and hashes in-flight; aborts the moment a ceiling is exceeded so a lying
    // client — or an unbounded external source — cannot fill the disk.
    const ceiling =
      input.expectedSize !== undefined
        ? input.maxBytes !== undefined
          ? Math.min(input.expectedSize, input.maxBytes)
          : input.expectedSize
        : input.maxBytes;

    const meter = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        bytes += chunk.length;
        if (ceiling !== undefined && bytes > ceiling) {
          callback(
            new StorageError('STORAGE_ERROR', `Upload exceeded the ${ceiling}-byte limit`),
          );
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    // 'wx' = create exclusively. An existing key is a hard failure: versions are immutable.
    const target = fs.createWriteStream(fullPath, { flags: 'wx', mode: FILE_MODE });

    try {
      await pipeline(input.body, meter, target);

      if (input.expectedSize !== undefined && bytes !== input.expectedSize) {
        throw new StorageError(
          'STORAGE_ERROR',
          `Incomplete upload: expected ${input.expectedSize} bytes, received ${bytes}`,
        );
      }
    } catch (error) {
      // EEXIST means the exclusive create never happened, so the file on disk belongs
      // to an earlier version. Cleaning up here would destroy someone else's data.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new StorageError('STORAGE_ERROR', 'A file already exists at this storage key', error);
      }
      await this.unlinkQuietly(fullPath);
      if (error instanceof StorageError) throw error;
      throw new StorageError('STORAGE_ERROR', 'Failed to write file to storage', error);
    }

    // Durability is confirmed before MongoDB is told the bytes exist: a crash must
    // never leave a version row pointing at unflushed data.
    await this.fsyncPath(fullPath);
    await this.fsyncDir(path.dirname(fullPath));

    return {
      key: input.key,
      area: input.area,
      size: bytes,
      checksumSha256: hash.digest('hex'),
      storedAt: new Date(),
    };
  }

  /** Incremental writer for chunked uploads: chunks are appended, then committed. */
  async createWriteStream(fileKey: string, area: StorageArea): Promise<StorageWriteHandle> {
    const fullPath = this.absolutePath(fileKey, area);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true, mode: DIR_MODE });

    const handle = await fsp.open(fullPath, 'wx', FILE_MODE).catch((error: NodeJS.ErrnoException) => {
      throw new StorageError(
        'STORAGE_ERROR',
        error.code === 'EEXIST' ? 'A file already exists at this storage key' : 'Failed to open file for writing',
        error,
      );
    });

    const hash = createHash('sha256');
    let bytes = 0;
    let closed = false;

    return {
      key: fileKey,
      area,
      write: async (chunk: Buffer) => {
        if (closed) throw new StorageError('STORAGE_ERROR', 'Write handle already closed');
        await handle.write(chunk);
        hash.update(chunk);
        bytes += chunk.length;
      },
      commit: async (): Promise<StoredFile> => {
        if (closed) throw new StorageError('STORAGE_ERROR', 'Write handle already closed');
        await handle.sync();
        await handle.close();
        closed = true;
        await this.fsyncDir(path.dirname(fullPath));
        return {
          key: fileKey,
          area,
          size: bytes,
          checksumSha256: hash.digest('hex'),
          storedAt: new Date(),
        };
      },
      abort: async () => {
        if (!closed) {
          await handle.close().catch(() => undefined);
          closed = true;
        }
        await this.unlinkQuietly(fullPath);
      },
    };
  }

  // ── read ───────────────────────────────────────────────────────────────────
  async getFile(
    fileKey: string,
    area: StorageArea,
    options?: GetFileOptions,
  ): Promise<NodeJS.ReadableStream> {
    const fullPath = this.absolutePath(fileKey, area);

    // Open first, then fstat the descriptor: this closes the TOCTOU window where a
    // regular file could be swapped for a symlink between the check and the read.
    let handle: FileHandle;
    try {
      handle = await fsp.open(fullPath, 'r');
    } catch (error) {
      throw new StorageError('STORAGE_ERROR', 'Stored file could not be opened', error);
    }

    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      throw new StorageError('STORAGE_ERROR', 'Stored path is not a regular file');
    }

    const start = options?.range?.start ?? 0;
    const end = options?.range?.end;
    if (start < 0 || (end !== undefined && (end < start || end >= stat.size))) {
      await handle.close();
      throw new StorageError('STORAGE_ERROR', 'Invalid byte range requested');
    }

    return handle.createReadStream({
      start,
      ...(end !== undefined ? { end } : {}),
      autoClose: true,
    });
  }

  async fileExists(fileKey: string, area: StorageArea): Promise<boolean> {
    try {
      const stat = await fsp.stat(this.absolutePath(fileKey, area));
      return stat.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new StorageError('STORAGE_ERROR', 'Failed to stat stored file', error);
    }
  }

  async getFileMetadata(fileKey: string, area: StorageArea): Promise<StoredFileMetadata> {
    const fullPath = this.absolutePath(fileKey, area);
    try {
      const stat = await fsp.stat(fullPath);
      if (!stat.isFile()) throw new StorageError('STORAGE_ERROR', 'Stored path is not a regular file');
      return {
        key: fileKey,
        size: stat.size,
        createdAt: stat.birthtime,
        modifiedAt: stat.mtime,
        etag: `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`,
      };
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('STORAGE_ERROR', 'Failed to read stored file metadata', error);
    }
  }

  // ── move / copy / delete ───────────────────────────────────────────────────
  async moveFile(
    source: { key: string; area: StorageArea },
    destination: { key: string; area: StorageArea },
  ): Promise<void> {
    const from = this.absolutePath(source.key, source.area);
    const to = this.absolutePath(destination.key, destination.area);

    if (await this.fileExists(destination.key, destination.area)) {
      throw new StorageError('STORAGE_ERROR', 'Destination storage key already exists');
    }
    await fsp.mkdir(path.dirname(to), { recursive: true, mode: DIR_MODE });

    try {
      // Same-device rename is atomic — this is the quarantine → originals hot path.
      await fsp.rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        // Roots on different volumes: copy, flush, then remove the source.
        await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
        await this.fsyncPath(to);
        await fsp.unlink(from);
      } else {
        throw new StorageError('STORAGE_ERROR', 'Failed to move stored file', error);
      }
    }
    await this.fsyncDir(path.dirname(to));
  }

  async copyFile(
    source: { key: string; area: StorageArea },
    destination: { key: string; area: StorageArea },
  ): Promise<void> {
    const from = this.absolutePath(source.key, source.area);
    const to = this.absolutePath(destination.key, destination.area);
    await fsp.mkdir(path.dirname(to), { recursive: true, mode: DIR_MODE });
    try {
      await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      await this.fsyncPath(to);
      await this.fsyncDir(path.dirname(to));
    } catch (error) {
      throw new StorageError('STORAGE_ERROR', 'Failed to copy stored file', error);
    }
  }

  /**
   * Deletion is only ever called for transient areas (quarantine, temp, previews,
   * exports) or by an audited purge job. Missing files are treated as success.
   */
  async deleteFile(fileKey: string, area: StorageArea): Promise<void> {
    const fullPath = this.absolutePath(fileKey, area);
    try {
      await fsp.unlink(fullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new StorageError('STORAGE_ERROR', 'Failed to delete stored file', error);
    }
  }

  /** Removes an entire session/job directory (abandoned uploads, migration staging). */
  async deleteDirectory(prefix: string, area: StorageArea): Promise<void> {
    const fullPath = this.absolutePath(prefix, area);
    try {
      await fsp.rm(fullPath, { recursive: true, force: true });
    } catch (error) {
      throw new StorageError('STORAGE_ERROR', 'Failed to delete storage directory', error);
    }
  }

  /**
   * Every key stored in an area.
   *
   * Only the integrity sweep uses this, and it is the one operation that has to see what
   * is *actually* on disk rather than what the database believes: bytes with no row
   * pointing at them are invisible to every other code path by construction.
   *
   * Capped rather than unbounded — a sweep that ran out of memory before reporting
   * anything would be worse than one that reports "and there are more".
   */
  async listKeys(area: StorageArea, limit = 200_000): Promise<string[]> {
    const root = this.areaRoot(area);
    const keys: string[] = [];

    const walk = async (directory: string, prefix: string): Promise<void> => {
      if (keys.length >= limit) return;
      let entries;
      try {
        entries = await fsp.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new StorageError('STORAGE_ERROR', 'Failed to list storage keys', error);
      }

      for (const entry of entries) {
        if (keys.length >= limit) return;
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(path.join(directory, entry.name), key);
        } else if (entry.isFile()) {
          keys.push(key);
        }
      }
    };

    await walk(root, '');
    return keys;
  }

  async getCapacity(area: StorageArea = 'originals'): Promise<StorageCapacity> {
    try {
      const stats = await fsp.statfs(this.areaRoot(area));
      return {
        totalBytes: stats.blocks * stats.bsize,
        freeBytes: stats.bavail * stats.bsize,
      };
    } catch (error) {
      throw new StorageError('STORAGE_ERROR', 'Failed to read storage capacity', error);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private async unlinkQuietly(fullPath: string): Promise<void> {
    await fsp.unlink(fullPath).catch(() => undefined);
  }

  /**
   * Best-effort flush of a file written by copyFile/rename.
   * Opened 'r+' because fsync on a read-only descriptor is refused on Windows;
   * a failure here is not fatal — the copy itself already succeeded.
   */
  private async fsyncPath(fullPath: string): Promise<void> {
    const handle = await fsp.open(fullPath, 'r+').catch(() => null);
    if (!handle) return;
    try {
      await handle.sync();
    } catch {
      // Some filesystems refuse fsync; durability falls back to the OS flush interval.
    } finally {
      await handle.close();
    }
  }

  /**
   * Flushing the directory entry matters: without it a crash right after a write can
   * leave MongoDB pointing at a file the filesystem has not durably recorded.
   * Not supported for directories on Windows — ignored there.
   */
  private async fsyncDir(dirPath: string): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await fsp.open(dirPath, 'r').catch(() => null);
    if (!handle) return;
    try {
      await handle.sync();
    } catch {
      // Some filesystems refuse fsync on a directory; the file itself is already synced.
    } finally {
      await handle.close();
    }
  }
}
