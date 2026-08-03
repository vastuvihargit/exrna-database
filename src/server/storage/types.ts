/**
 * Storage abstraction.
 *
 * The application never touches the filesystem directly — it goes through a
 * StorageProvider. LocalStorageProvider is the MVP implementation; an S3/MinIO/R2
 * provider can replace it without any change above this layer.
 *
 * Deliberately framework-free: no Next.js, no Mongoose, no knowledge of users
 * or permissions. Authorization happens above; this layer only moves bytes safely.
 */

/** Logical areas of the storage tree; each maps to a configured root directory. */
export type StorageArea =
  | 'originals'
  | 'versions'
  | 'previews'
  | 'quarantine'
  | 'migration-staging'
  | 'temporary'
  | 'exports'
  | 'archives';

export interface SaveFileInput {
  /** Relative, provider-scoped key. Never an absolute path. */
  key: string;
  area: StorageArea;
  body: NodeJS.ReadableStream;
  /**
   * Exact expected length. The write is aborted and the partial file removed if the
   * stream is longer *or* shorter — a truncated upload is not a smaller file, it is a
   * corrupt one.
   */
  expectedSize?: number;
  /**
   * Upper bound for a stream whose length is not known in advance — an export from an
   * external service, where there is no declared size to compare against. Aborts the
   * moment it is exceeded, so an unbounded source cannot fill the disk.
   */
  maxBytes?: number;
  contentType?: string;
  /**
   * Literal `false` by design: a stored version is immutable, so the type system
   * refuses to express "overwrite this file".
   */
  overwrite?: false;
}

export interface StoredFile {
  key: string;
  area: StorageArea;
  /** Measured during the write — never the client-declared value. */
  size: number;
  /** Lower-case hex SHA-256, computed while streaming. */
  checksumSha256: string;
  storedAt: Date;
}

export interface StoredFileMetadata {
  key: string;
  size: number;
  contentType?: string;
  createdAt: Date;
  modifiedAt: Date;
  etag?: string;
}

export interface GetFileOptions {
  /** Byte range, inclusive. Powers HTTP Range requests for audio/video. */
  range?: { start: number; end?: number };
}

/** Incremental writer used by chunked/resumable uploads. */
export interface StorageWriteHandle {
  key: string;
  area: StorageArea;
  write(chunk: Buffer): Promise<void>;
  commit(): Promise<StoredFile>;
  abort(): Promise<void>;
}

export interface StorageCapacity {
  totalBytes: number;
  freeBytes: number;
}

/**
 * Providers that can hold durable file content.
 *
 * These values are persisted in MongoDB (`FileVersion.storageProvider`), so they are a
 * stable contract, not an implementation detail — renaming one is a data migration.
 */
export const STORAGE_PROVIDERS = ['local', 'google_drive'] as const;
export type StorageProviderName = (typeof STORAGE_PROVIDERS)[number];

/**
 * Where one stored object actually is.
 *
 * This is what the database hands to the storage layer, and it is deliberately a *union*
 * of both addressing schemes rather than one or the other:
 *
 *   • `key` + `area`  — the local, filesystem-style address. Always present, and never
 *     cleared once set, even after the object has been copied to an external provider.
 *     That is what makes reverting a file to local storage a single field flip with no
 *     data movement (docs/storage-migration/00-phase-0-analysis.md §8).
 *   • `externalId`    — the provider-native handle (a Google Drive file id). Absent for
 *     anything that has never left this server.
 *
 * A provider reads the half that addresses it and ignores the other. Neither branches on
 * the other's fields.
 */
export interface StorageLocator {
  provider: StorageProviderName;
  key: string;
  area: StorageArea;
  externalId?: string;
  externalRevisionId?: string;
}

/** Where a new object should be written. */
export interface StorageWriteTarget {
  key: string;
  area: StorageArea;
  /**
   * Provider-native parent — a Drive folder id. Ignored by providers with no hierarchy,
   * which is why folder mirroring cannot leak into the local code path.
   */
  externalParentId?: string;
  /** The name the object should carry in a provider that stores names. */
  displayName?: string;
  contentType?: string;
}

/**
 * A stored object, plus whatever the provider assigned to it.
 *
 * The external fields are optional because the local provider assigns none. A caller that
 * needs them has already decided which provider it is talking to.
 */
export interface StoredObject {
  provider: StorageProviderName;
  key: string;
  area: StorageArea;
  size: number;
  /**
   * Present only when the provider actually measured it during the write. A server-side
   * copy does not re-read the bytes to re-hash them, and reporting the source's digest as
   * though it had been verified would be a claim nothing checked.
   */
  checksumSha256?: string;
  storedAt: Date;
  /**
   * MD5, present only for providers that publish one. Google Drive exposes `md5Checksum`
   * and no SHA-256, so this is what a migration compares its own locally-computed digest
   * against to prove the round trip — verifying by re-downloading would double the transfer
   * cost of the entire corpus.
   */
  checksumMd5?: string;
  externalId?: string;
  externalParentId?: string;
  externalRevisionId?: string;
  externalWebViewLink?: string;
}

export interface ObjectUploadInput {
  target: StorageWriteTarget;
  body: NodeJS.ReadableStream;
  /** Exact expected length. The write fails if the stream disagrees. */
  size?: number;
  /**
   * The digest the caller already computed off local disk. When given, the provider
   * compares it against what the remote service reports and fails the upload on a
   * mismatch, so a corrupted transfer is never recorded as a successful one.
   */
  expectedMd5?: string;
  /**
   * Provider-native metadata stamped onto the object. Carries the idempotency key that
   * lets a transfer orphaned between "remote committed" and "database committed" be found
   * and adopted rather than uploaded twice.
   */
  properties?: Record<string, string>;
}

/**
 * A store that content can be written *directly* to.
 *
 * Separate from `ObjectStore` because the local path does not want it: bytes arriving from
 * a browser are staged in quarantine, size-checked, hashed, signature-checked and scanned
 * by `upload.service` through `StorageProvider` before anything is trusted, and that
 * pipeline is not something a second write surface should be able to bypass. Only the
 * external providers — where "put these already-verified bytes over there" is a single
 * operation — implement this.
 */
export interface WritableObjectStore extends ObjectStore {
  put(input: ObjectUploadInput): Promise<StoredObject>;
}

export function isWritableObjectStore(store: ObjectStore): store is WritableObjectStore {
  return typeof (store as WritableObjectStore).put === 'function';
}

/**
 * The provider-agnostic surface the application uses.
 *
 * Every method takes a `StorageLocator` — never a bare key — so a call site physically
 * cannot read an object without first having said which provider owns it. That is the
 * property that makes dual-storage safe: there is no default location to fall back to.
 *
 * Deliberately narrower than `StorageProvider`. Quarantine writes, chunk assembly,
 * capacity checks and key listing are local-only concerns by design (§9.1 of the Phase 0
 * analysis: bytes are scanned and verified on this server before any external provider
 * sees them), so they stay on the local provider and are absent here.
 */
export interface ObjectStore {
  readonly provider: StorageProviderName;

  read(locator: StorageLocator, options?: GetFileOptions): Promise<NodeJS.ReadableStream>;
  exists(locator: StorageLocator): Promise<boolean>;
  metadata(locator: StorageLocator): Promise<StoredFileMetadata>;
  /** Missing objects are success: deletion is idempotent everywhere. */
  remove(locator: StorageLocator): Promise<void>;
  copy(source: StorageLocator, destination: StorageWriteTarget): Promise<StoredObject>;
}

export interface StoredFolderResult {
  externalId: string;
  externalParentId: string | null;
  name: string;
}

export interface EnsureFolderInput {
  name: string;
  /** Null means the provider's configured root. */
  parentExternalId: string | null;
  /**
   * Our own folder id. Passed so a provider that supports custom metadata can stamp it on
   * the remote folder, which is what lets an orphaned remote folder be adopted rather than
   * duplicated after a crash.
   */
  appFolderId: string;
}

/**
 * Folder mirroring.
 *
 * Separate from `ObjectStore` because it is a genuinely different capability: a local
 * folder has no storage-side existence at all (the hierarchy lives entirely in MongoDB),
 * whereas a Drive folder is a real object with an id.
 *
 * The local implementation answers every call successfully without doing anything. That is
 * not a stub — it is the truthful answer for a provider whose folders are database rows —
 * and it is what lets folder services call these methods unconditionally instead of
 * branching on the provider name.
 */
export interface HierarchicalStorageProvider {
  readonly provider: StorageProviderName;

  ensureFolder(input: EnsureFolderInput): Promise<StoredFolderResult | null>;
  renameItem(externalId: string, name: string): Promise<void>;
  moveItem(externalId: string, newParentExternalId: string, oldParentExternalId?: string): Promise<void>;
  trashItem(externalId: string): Promise<void>;
  restoreItem(externalId: string): Promise<void>;
  deleteItem(externalId: string): Promise<void>;
  itemExists(externalId: string): Promise<boolean>;
}

export interface StorageProvider {
  readonly name: StorageProviderName;

  saveFile(input: SaveFileInput): Promise<StoredFile>;
  getFile(fileKey: string, area: StorageArea, options?: GetFileOptions): Promise<NodeJS.ReadableStream>;
  deleteFile(fileKey: string, area: StorageArea): Promise<void>;
  fileExists(fileKey: string, area: StorageArea): Promise<boolean>;
  moveFile(source: { key: string; area: StorageArea }, destination: { key: string; area: StorageArea }): Promise<void>;
  copyFile(source: { key: string; area: StorageArea }, destination: { key: string; area: StorageArea }): Promise<void>;
  getFileMetadata(fileKey: string, area: StorageArea): Promise<StoredFileMetadata>;
  createWriteStream(fileKey: string, area: StorageArea): Promise<StorageWriteHandle>;
  /**
   * Every key in an area. Used only by the integrity sweep, which has to see what is
   * actually stored rather than what the database believes — bytes with no row pointing
   * at them are invisible to every other code path by construction.
   */
  listKeys(area: StorageArea, limit?: number): Promise<string[]>;
  /** Used by the health check and the pre-upload free-space guard. */
  getCapacity(area?: StorageArea): Promise<StorageCapacity>;
  /** Creates the area directories if they do not exist. Called at boot. */
  ensureReady(): Promise<void>;
}
