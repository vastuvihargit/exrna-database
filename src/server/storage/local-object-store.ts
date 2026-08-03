/**
 * The local filesystem, presented as an `ObjectStore`.
 *
 * A deliberately thin adapter over `LocalStorageProvider`: it translates a
 * `StorageLocator` into the provider's key/area addressing and adds nothing else. All the
 * hard guarantees — exclusive create, streamed hashing, path-escape refusal, fsync,
 * symlink refusal — stay exactly where they are, in the provider, unchanged and covered by
 * the tests that already exist for them.
 *
 * Writing it as a wrapper rather than editing `LocalStorageProvider` is the point: the one
 * module in this codebase that touches the filesystem is not modified by the Google Drive
 * migration at all, so nothing that currently works can regress because of it.
 */
import { StorageError } from '@/server/errors/app-error';
import type {
  GetFileOptions,
  HierarchicalStorageProvider,
  ObjectStore,
  StorageLocator,
  StorageProvider,
  StorageWriteTarget,
  StoredFileMetadata,
  StoredFolderResult,
  StoredObject,
} from './types';

export class LocalObjectStore implements ObjectStore, HierarchicalStorageProvider {
  readonly provider = 'local' as const;

  constructor(private readonly files: StorageProvider) {}

  /**
   * A locator that names a different provider has been routed to the wrong store. That is
   * a programming error rather than a storage failure, and it is caught here so it can
   * never degrade into "read the local key instead" — which would silently serve the wrong
   * bytes for a migrated file whose local copy is still present.
   */
  private assertLocal(locator: StorageLocator): void {
    if (locator.provider !== 'local') {
      throw new StorageError(
        'STORAGE_ERROR',
        `Local object store received a "${locator.provider}" locator`,
      );
    }
  }

  async read(locator: StorageLocator, options?: GetFileOptions): Promise<NodeJS.ReadableStream> {
    this.assertLocal(locator);
    return this.files.getFile(locator.key, locator.area, options);
  }

  async exists(locator: StorageLocator): Promise<boolean> {
    this.assertLocal(locator);
    return this.files.fileExists(locator.key, locator.area);
  }

  async metadata(locator: StorageLocator): Promise<StoredFileMetadata> {
    this.assertLocal(locator);
    return this.files.getFileMetadata(locator.key, locator.area);
  }

  async remove(locator: StorageLocator): Promise<void> {
    this.assertLocal(locator);
    await this.files.deleteFile(locator.key, locator.area);
  }

  async copy(source: StorageLocator, destination: StorageWriteTarget): Promise<StoredObject> {
    this.assertLocal(source);
    await this.files.copyFile(
      { key: source.key, area: source.area },
      { key: destination.key, area: destination.area },
    );

    // Reported from the copy that now exists on disk rather than from the source record,
    // so a caller cannot be told about bytes that were never written.
    const written = await this.files.getFileMetadata(destination.key, destination.area);
    return {
      provider: 'local',
      key: destination.key,
      area: destination.area,
      size: written.size,
      // No checksum: the copy was not hashed. Re-reading the whole file to produce a
      // digest the caller already holds would double the I/O of every version restore.
      storedAt: written.modifiedAt,
    };
  }

  /* ------------------------------------------------- folder mirroring (no-ops) */

  /**
   * Local folders exist only as MongoDB rows — there is no directory to create, because
   * storage keys are flat generated identifiers and never mirror the user's hierarchy
   * (`storage/keys.ts`). Returning `null` is the truthful answer: "this provider has no
   * folder object for you to record", and every caller stores nothing as a result.
   */
  async ensureFolder(): Promise<StoredFolderResult | null> {
    return null;
  }

  async renameItem(): Promise<void> {}
  async moveItem(): Promise<void> {}
  async trashItem(): Promise<void> {}
  async restoreItem(): Promise<void> {}
  async deleteItem(): Promise<void> {}

  /**
   * False, always: a local item has no external id, so nothing can be found by one. This
   * is the honest answer rather than `true`, which would let a reconciliation sweep
   * conclude that a nonexistent remote object is present.
   */
  async itemExists(): Promise<boolean> {
    return false;
  }
}
