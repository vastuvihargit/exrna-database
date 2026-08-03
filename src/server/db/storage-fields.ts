/**
 * Shared storage-location vocabulary.
 *
 * `FileVersion`, `Folder`, `File`, `StorageMigrationItem` and `DriveSyncState` all describe
 * the same few ideas — which provider holds this, how far through migration it is, whether
 * it is in sync. Defining them once means the five cannot drift into disagreeing about what
 * `verified` means, which is the kind of divergence that only shows up when a migration
 * query silently returns nothing.
 *
 * **Every value here is persisted in MongoDB, so this file is a data contract.** Renaming a
 * string is a database migration, not a refactor.
 *
 * All of these fields are additive and every one has a default. An existing document that
 * predates them stays valid and reads back as `local` / `not_started` / `not_required`,
 * with no backfill — which is the whole reason Phase 3 can ship without a write lock on the
 * `filesversions` collection.
 */
import { STORAGE_PROVIDERS } from '@/server/storage/types';

/**
 * Re-exported rather than redefined. The storage layer already owns this list because it is
 * what the provider registry dispatches on; a second copy here would be two sources of
 * truth for a value that is written into every version document.
 */
export { STORAGE_PROVIDERS };
export type { StorageProviderName } from '@/server/storage/types';

/**
 * A *file* may legitimately be split across providers while a migration is in flight — v1
 * still local, v2 already in Drive. `mixed` is that real state, not an error, and it exists
 * so the admin dashboard can count it instead of having to guess from the version rows.
 */
export const FILE_STORAGE_PROVIDERS = ['local', 'google_drive', 'mixed'] as const;
export type FileStorageProvider = (typeof FILE_STORAGE_PROVIDERS)[number];

/**
 * How far one object has got through migration.
 *
 * `uploaded` and `verified` are deliberately distinct: bytes reaching Drive is not the same
 * event as those bytes being proved correct, and only `verified` may ever authorise
 * deleting the local copy.
 */
export const STORAGE_MIGRATION_STATUSES = [
  'not_started',
  'queued',
  'uploading',
  'uploaded',
  'verifying',
  'verified',
  'failed',
  'rolled_back',
] as const;
export type StorageMigrationStatus = (typeof STORAGE_MIGRATION_STATUSES)[number];

/** Statuses that mean a transfer is in flight and the object must not be claimed twice. */
export const IN_FLIGHT_MIGRATION_STATUSES = ['uploading', 'uploaded', 'verifying'] as const;

/**
 * Whether the application's record agrees with what is actually in Drive.
 *
 * `not_required` is the default and covers every local object: there is nothing external to
 * be out of step with. It is a distinct state from `synced` on purpose — "never needed
 * checking" and "checked and agreed" answer different questions during an incident.
 */
export const SYNC_STATUSES = ['not_required', 'pending', 'synced', 'failed', 'conflict'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Sync states worth a worker's attention. `synced` and `not_required` need no action. */
export const ACTIONABLE_SYNC_STATUSES = ['pending', 'failed', 'conflict'] as const;

/**
 * The local copy after migration.
 *
 * Retaining it is the entire rollback mechanism: reverting a version to local storage is a
 * single field change with no data movement, and that only works while the bytes are still
 * there. `deleted` is reachable only through an explicit, audited admin action.
 */
export const LOCAL_COPY_STATES = ['present', 'archived', 'deleted'] as const;
export type LocalCopyState = (typeof LOCAL_COPY_STATES)[number];

/** Folder mirroring progress. Separate from migration status: folders carry no bytes. */
export const DRIVE_MAPPING_STATUSES = ['none', 'creating', 'mapped', 'failed'] as const;
export type DriveMappingStatus = (typeof DRIVE_MAPPING_STATUSES)[number];

/** Google-native document kinds. These have no bytes and can only be exported. */
export const GOOGLE_NATIVE_KINDS = ['document', 'spreadsheet', 'presentation'] as const;
export type GoogleNativeKind = (typeof GOOGLE_NATIVE_KINDS)[number];

/**
 * Where one stored object lives externally, plus its lifecycle.
 *
 * Spread into `FileVersion`. Note what is *not* here: `storageKey` stays exactly where it
 * is, required and unique, and is never cleared. After migration a version carries both a
 * local key and a Drive id, and that redundancy is deliberate — it is what makes rollback a
 * field flip instead of a data migration.
 */
export const driveObjectFields = {
  storageProvider: { type: String, enum: STORAGE_PROVIDERS, default: 'local' },

  googleDriveFileId: { type: String, default: null, maxlength: 200 },
  googleDriveParentId: { type: String, default: null, maxlength: 200 },
  /** Binds an approval to an exact state; changes when a native document is edited. */
  googleDriveRevisionId: { type: String, default: null, maxlength: 200 },
  /** Drive publishes MD5 and no SHA-256, so this is what a re-verification compares. */
  googleDriveMd5: { type: String, default: null, maxlength: 32 },
  /**
   * When Drive last reported the *content* as modified.
   *
   * Kept alongside the revision id rather than instead of it. The revision is the identity
   * and is what a comparison is decided on; this is what an administrator reads when asked
   * "when did that document change?", and a revision id answers that question not at all.
   */
  googleDriveModifiedTime: { type: Date, default: null },
  googleDriveWebViewLink: { type: String, default: null, maxlength: 1000 },

  migrationStatus: { type: String, enum: STORAGE_MIGRATION_STATUSES, default: 'not_started' },
  migratedAt: { type: Date, default: null },
  migrationFailureReason: { type: String, default: null, maxlength: 500 },

  syncStatus: { type: String, enum: SYNC_STATUSES, default: 'not_required' },
  lastSyncedAt: { type: Date, default: null },

  localCopyState: { type: String, enum: LOCAL_COPY_STATES, default: 'present' },
  localCopyEligibleForDeletionAt: { type: Date, default: null },
  /**
   * Where an archived local copy went.
   *
   * A separate field rather than a rewrite of `storageKey`/`storageArea`, which are immutable
   * and must stay that way — they record the address the version was created at, and a
   * migration able to rewrite them could hide a bad transfer by simply recording the wrong
   * address as expected. This says "the bytes are still here, just moved aside", which is
   * what makes an archived copy something rollback can still restore from.
   */
  archivedStorageKey: { type: String, default: null, maxlength: 500 },
  localCopyArchivedAt: { type: Date, default: null },
  localCopyDeletedAt: { type: Date, default: null },

  isGoogleNative: { type: Boolean, default: false },
  // `null` is in the enum list because Mongoose validates a null against `enum` rather than
  // skipping it, and "not a native document" is the normal case for every existing row.
  googleNativeKind: { type: String, enum: [...GOOGLE_NATIVE_KINDS, null], default: null },
} as const;

/**
 * A folder's Drive counterpart.
 *
 * Folders are mirrored lazily — created the first time content needs to land in one — so
 * the overwhelmingly common state is `none`, and that is the default.
 */
export const driveFolderFields = {
  storageProvider: { type: String, enum: STORAGE_PROVIDERS, default: 'local' },
  googleDriveFolderId: { type: String, default: null, maxlength: 200 },
  googleDriveParentFolderId: { type: String, default: null, maxlength: 200 },
  driveMappingStatus: { type: String, enum: DRIVE_MAPPING_STATUSES, default: 'none' },
  driveMappedAt: { type: Date, default: null },
  syncStatus: { type: String, enum: SYNC_STATUSES, default: 'not_required' },
} as const;
