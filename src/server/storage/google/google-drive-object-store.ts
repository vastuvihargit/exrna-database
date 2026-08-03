/**
 * Google Shared Drive, presented as an `ObjectStore` and a `HierarchicalStorageProvider`.
 *
 * The mirror image of `LocalObjectStore`: it translates a `StorageLocator` into Drive's
 * addressing and adds the few policies that are genuinely storage-level — verify what came
 * back, adopt an orphan rather than duplicate it, treat deletion as idempotent.
 *
 * What it deliberately does **not** do:
 *
 *   • No permission checks. It receives no `Actor`, no request, no Mongoose model. Every
 *     caller has already passed `requireFile` / `requireFolder`; duplicating that here
 *     would create a second, divergent authorization model — and one that silently
 *     disagreed with MongoDB would be worse than none.
 *   • No knowledge of `FileVersion`, folders-as-rows, migration state or approvals. It is
 *     handed an id and a parent id and moves bytes.
 *   • No fallback to the local key. A locator naming another provider is a routing bug and
 *     throws, for the same reason it does locally: reading whatever stale copy happens to
 *     be on disk and reporting it as success is the worst available outcome.
 */
import { createHash } from 'crypto';
import { Transform } from 'stream';
import { StorageError } from '@/server/errors/app-error';
import type {
  EnsureFolderInput,
  GetFileOptions,
  HierarchicalStorageProvider,
  ObjectUploadInput,
  StorageLocator,
  StorageWriteTarget,
  StoredFileMetadata,
  StoredFolderResult,
  StoredObject,
  WritableObjectStore,
} from '../types';
import type { DriveStorageConfig } from './drive-config';
import {
  escapeDriveQueryValue,
  GOOGLE_FOLDER_MIME,
  isGoogleNativeMimeType,
  type DriveClient,
  type DriveFileResource,
} from './drive-client';
import { DriveApiError } from './drive-errors';

/**
 * Stamped on every folder this application creates, so an adoption search matches on
 * *our own identifier* rather than on a name. Matching folders by name is how a migration
 * ends up writing into a folder somebody happened to create by hand with the same label.
 */
const APP_FOLDER_ID_PROPERTY = 'appFolderId';

const DEFAULT_BINARY_MIME = 'application/octet-stream';

export class GoogleDriveObjectStore implements WritableObjectStore, HierarchicalStorageProvider {
  readonly provider = 'google_drive' as const;

  constructor(
    private readonly client: DriveClient,
    private readonly config: DriveStorageConfig,
  ) {}

  /** The parent everything hangs from: the configured folder, or the drive's own root. */
  get rootExternalId(): string {
    return this.config.rootFolderId ?? this.config.sharedDriveId;
  }

  private externalId(locator: StorageLocator): string {
    if (locator.provider !== 'google_drive') {
      throw new StorageError(
        'STORAGE_ERROR',
        `Google Drive object store received a "${locator.provider}" locator`,
      );
    }
    if (!locator.externalId) {
      // A record marked as living in Drive with no Drive id is a half-written migration, not
      // a file to go looking for. Failing here keeps that visible instead of quietly
      // resolving to the retained local copy.
      throw new StorageError(
        'STORAGE_ERROR',
        'This record is marked as stored in Google Drive but carries no Drive file id',
      );
    }
    return locator.externalId;
  }

  /* ----------------------------------------------------------------------- reads */

  async read(locator: StorageLocator, options?: GetFileOptions): Promise<NodeJS.ReadableStream> {
    const id = this.externalId(locator);
    try {
      return await this.client.downloadFile(id, options?.range);
    } catch (error) {
      // Google-native documents hold no bytes and answer `alt=media` with this. Translated
      // rather than passed through, because "403 fileNotDownloadable" tells the caller
      // nothing about what to do instead.
      if (error instanceof DriveApiError && error.reason === 'fileNotDownloadable') {
        throw new StorageError(
          'STORAGE_ERROR',
          'This is a Google-native document and has no stored bytes; it must be exported to a chosen format.',
          error,
        );
      }
      throw error;
    }
  }

  /**
   * A Google-native document converted to a real file format.
   *
   * Separate from `read` on purpose: exporting is lossy and format-dependent, so which
   * format is a decision the caller must make explicitly rather than one this layer
   * guesses at.
   */
  async exportNative(locator: StorageLocator, mimeType: string): Promise<NodeJS.ReadableStream> {
    return this.client.exportFile(this.externalId(locator), mimeType);
  }

  async exists(locator: StorageLocator): Promise<boolean> {
    try {
      await this.client.getFile(this.externalId(locator));
      return true;
    } catch (error) {
      if (error instanceof DriveApiError && error.status === 404) return false;
      throw error;
    }
  }

  async metadata(locator: StorageLocator): Promise<StoredFileMetadata> {
    const file = await this.client.getFile(this.externalId(locator));
    return {
      key: locator.key,
      size: Number(file.size ?? 0),
      contentType: file.mimeType,
      createdAt: file.createdTime ? new Date(file.createdTime) : new Date(0),
      modifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : new Date(0),
      // The revision, not the MD5: this is what an approval binds to, and it changes when
      // a Google-native document is edited even though such a document has no MD5 at all.
      etag: file.headRevisionId,
    };
  }

  /** Missing is success. Deletion is idempotent in every provider in this codebase. */
  async remove(locator: StorageLocator): Promise<void> {
    await this.client.deleteFile(this.externalId(locator));
  }

  /* ---------------------------------------------------------------------- writes */

  /**
   * Server-side copy — the bytes never traverse this server.
   *
   * Drive assigns a fresh id and its own MD5, both read back from the response rather than
   * carried over from the source, so a caller is never told about a copy that was not
   * actually made.
   */
  async copy(source: StorageLocator, destination: StorageWriteTarget): Promise<StoredObject> {
    const parentId = destination.externalParentId ?? this.rootExternalId;
    const copied = await this.client.copyFile(this.externalId(source), {
      name: destination.displayName ?? source.key,
      parentId,
    });
    return this.toStoredObject(copied, destination.key, destination.area);
  }

  /**
   * Uploads verified bytes.
   *
   * Both digests are computed *in the same streaming pass* as the transfer, so verification
   * costs no extra I/O and no extra memory:
   *
   *   • MD5 is compared against Drive's own `md5Checksum`, which proves the round trip.
   *   • SHA-256 is what the rest of this system stores and compares, so it is measured here
   *     rather than copied from the caller's record — reporting a digest nothing verified
   *     would defeat the point of having one.
   *
   * A mismatch deletes the remote object before throwing. Leaving it would put a file at a
   * real Drive id that no database row points at and no verification passed.
   */
  async put(input: ObjectUploadInput): Promise<StoredObject> {
    const md5 = createHash('md5');
    const sha256 = createHash('sha256');
    let observedSize = 0;

    const hashing = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        md5.update(buffer);
        sha256.update(buffer);
        observedSize += buffer.length;
        callback(null, buffer);
      },
    });
    input.body.pipe(hashing);
    // A failure on the source must surface on the stream the uploader is reading, or the
    // upload hangs waiting for bytes that will never arrive.
    input.body.on('error', (error) => hashing.destroy(error));

    const uploaded = await this.client.uploadFile({
      name: input.target.displayName ?? input.target.key,
      parentId: input.target.externalParentId ?? this.rootExternalId,
      mimeType: input.target.contentType ?? DEFAULT_BINARY_MIME,
      body: hashing,
      size: input.size,
      appProperties: input.properties,
    });

    const localMd5 = md5.digest('hex');
    const problem = this.verifyUpload(uploaded, {
      expectedMd5: input.expectedMd5 ?? localMd5,
      observedMd5: localMd5,
      observedSize,
    });

    if (problem) {
      await this.client.deleteFile(uploaded.id).catch(() => {
        // Best effort. The upload is failing either way; a leftover object is reported by
        // the reconciliation sweep rather than allowed to mask the real error here.
      });
      throw new StorageError('STORAGE_ERROR', problem);
    }

    return {
      ...this.toStoredObject(uploaded, input.target.key, input.target.area),
      size: observedSize,
      checksumSha256: sha256.digest('hex'),
      checksumMd5: localMd5,
    };
  }

  /**
   * Returns a description of what is wrong, or null.
   *
   * Google-native documents have no `md5Checksum` and never will; they are also never a
   * target of a byte upload, so an absent digest on an uploaded binary is a real anomaly
   * and is treated as one.
   */
  private verifyUpload(
    uploaded: DriveFileResource,
    observed: { expectedMd5: string; observedMd5: string; observedSize: number },
  ): string | null {
    if (observed.expectedMd5 !== observed.observedMd5) {
      return 'The uploaded bytes did not match the checksum recorded for this file';
    }

    const remoteSize = uploaded.size !== undefined ? Number(uploaded.size) : null;
    if (remoteSize !== null && remoteSize !== observed.observedSize) {
      return `Google Drive stored ${remoteSize} bytes but ${observed.observedSize} were sent`;
    }

    if (!uploaded.md5Checksum) {
      return 'Google Drive returned no checksum for the uploaded file, so the transfer could not be verified';
    }
    if (uploaded.md5Checksum.toLowerCase() !== observed.observedMd5.toLowerCase()) {
      return 'The file stored in Google Drive does not match the bytes that were sent';
    }

    return null;
  }

  private toStoredObject(file: DriveFileResource, key: string, area: StoredObject['area']): StoredObject {
    return {
      provider: 'google_drive',
      key,
      area,
      size: Number(file.size ?? 0),
      checksumMd5: file.md5Checksum,
      storedAt: file.modifiedTime ? new Date(file.modifiedTime) : new Date(),
      externalId: file.id,
      externalParentId: file.parents?.[0],
      externalRevisionId: file.headRevisionId,
      externalWebViewLink: file.webViewLink,
    };
  }

  /* ------------------------------------------------------------- folder mirroring */

  /**
   * The Drive folder for one application folder, created if it is not there yet.
   *
   * Adoption before creation, and adoption **only** by our own stamped id:
   *
   *   • A crash between "Drive created the folder" and "MongoDB recorded its id" leaves an
   *     orphan. Searching `appProperties.appFolderId` finds it and reuses it, so a retry
   *     converges instead of accumulating a duplicate on every attempt.
   *   • Never by name. Two sibling folders can legitimately share a name in Drive, and a
   *     name match would happily write research data into a folder a person created by
   *     hand for something else.
   *
   * The search is scoped to the intended parent, so an identically-stamped folder that has
   * been moved elsewhere is not silently adopted into the wrong place.
   */
  async ensureFolder(input: EnsureFolderInput): Promise<StoredFolderResult> {
    const parentId = input.parentExternalId ?? this.rootExternalId;

    const existing = await this.findFolderByAppId(input.appFolderId, parentId);
    if (existing) {
      return { externalId: existing.id, externalParentId: parentId, name: existing.name };
    }

    const created = await this.client.createFolder({
      name: input.name,
      parentId,
      appProperties: { [APP_FOLDER_ID_PROPERTY]: input.appFolderId },
    });

    return { externalId: created.id, externalParentId: parentId, name: created.name };
  }

  private async findFolderByAppId(appFolderId: string, parentId: string): Promise<DriveFileResource | null> {
    const query = [
      `mimeType = '${GOOGLE_FOLDER_MIME}'`,
      `'${escapeDriveQueryValue(parentId)}' in parents`,
      `appProperties has { key='${APP_FOLDER_ID_PROPERTY}' and value='${escapeDriveQueryValue(appFolderId)}' }`,
      'trashed = false',
    ].join(' and ');

    const page = await this.client.listFiles({ query, pageSize: 2 });
    return page.files[0] ?? null;
  }

  async renameItem(externalId: string, name: string): Promise<void> {
    await this.client.updateFile(externalId, { name });
  }

  /**
   * Drive models a move as "add this parent, remove that one", and the old parent must be
   * named explicitly. When the caller does not know it, it is read first — Drive items can
   * technically hold several parents, and removing the wrong one would leave the item in
   * both places.
   */
  async moveItem(externalId: string, newParentExternalId: string, oldParentExternalId?: string): Promise<void> {
    let removeParents = oldParentExternalId;
    if (!removeParents) {
      const current = await this.client.getFile(externalId);
      removeParents = current.parents?.join(',');
    }
    if (removeParents === newParentExternalId) return;

    await this.client.updateFile(externalId, {
      addParents: newParentExternalId,
      removeParents,
    });
  }

  async trashItem(externalId: string): Promise<void> {
    await this.client.updateFile(externalId, { trashed: true });
  }

  async restoreItem(externalId: string): Promise<void> {
    await this.client.updateFile(externalId, { trashed: false });
  }

  /** Permanent. Reserved for objects this application created and failed to record. */
  async deleteItem(externalId: string): Promise<void> {
    await this.client.deleteFile(externalId);
  }

  async itemExists(externalId: string): Promise<boolean> {
    try {
      await this.client.getFile(externalId);
      return true;
    } catch (error) {
      if (error instanceof DriveApiError && error.status === 404) return false;
      throw error;
    }
  }

  /* --------------------------------------------------------------------- inspection */

  /** Whether a stored object is a Google-native document rather than uploaded bytes. */
  async isGoogleNative(locator: StorageLocator): Promise<boolean> {
    const file = await this.client.getFile(this.externalId(locator));
    return isGoogleNativeMimeType(file.mimeType);
  }

  /**
   * What an approval binds to: the identity of the object's *current content*.
   *
   * One request, not two. `files.get` is deliberately not used here even though it is
   * cheaper-looking, because its `headRevisionId` is absent on Google-native documents —
   * see the comment on `DriveRevisionResource`. Reading the head revision directly gives an
   * id that is populated for both kinds, so one comparison covers a Doc and a .fastq alike.
   *
   * `md5` and `modifiedAt` are corroboration and may be absent; `revisionId` is the identity
   * and is never absent on a revision that exists.
   */
  async contentFingerprint(locator: StorageLocator): Promise<DriveContentFingerprint> {
    const revision = await this.client.getHeadRevision(this.externalId(locator));
    return {
      revisionId: revision.id,
      md5: revision.md5Checksum ?? null,
      modifiedAt: revision.modifiedTime ? new Date(revision.modifiedTime) : null,
    };
  }
}

/** The identity of an object's current content, as Drive reports it. */
export interface DriveContentFingerprint {
  revisionId: string;
  md5: string | null;
  modifiedAt: Date | null;
}
