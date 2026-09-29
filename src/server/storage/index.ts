/**
 * Storage entry point.
 *
 * Two surfaces, and the distinction is the whole design:
 *
 *   • `getStorageProvider()` — the local filesystem, addressed by key and area. Used by
 *     the paths that are local by definition: quarantine, chunk assembly, previews,
 *     exports, capacity checks and the integrity sweep's on-disk walk.
 *
 *   • `getObjectStore(provider)` — durable content, addressed by a `StorageLocator` that
 *     names its own provider. Used by every path that reads or copies a stored version,
 *     because those may live locally or in Google Shared Drive and the record decides,
 *     not the caller.
 *
 * Adding the Google Drive provider is a change to `registerProviders()` below and to
 * nothing else above this layer.
 */
import { getEnv } from '@/server/config/env';
import { LocalStorageProvider } from './local-provider';
import { LocalObjectStore } from './local-object-store';
import { getGoogleDriveStorage, isDriveStorageEnabled } from './google';
import { storageRegistry } from './registry';
import { isWorkerRuntime } from '@/server/runtime';
import type { ObjectStore, StorageProvider, StorageProviderName } from './types';

let provider: StorageProvider | null = null;
let registered = false;

export function getStorageProvider(): StorageProvider {
  if (!provider) {
    const env = getEnv();
    provider = new LocalStorageProvider({
      storage: env.storageRoots.storage,
      temp: env.storageRoots.temp,
      quarantine: env.storageRoots.quarantine,
      previews: env.storageRoots.previews,
      exports: env.storageRoots.exports,
    });
  }
  return provider;
}

/**
 * Populates the registry. Idempotent, and called lazily so that importing this module
 * never reads the environment — which matters for the unit tests that construct a
 * provider directly against a temporary directory.
 */
function registerProviders(): void {
  if (registered) return;

  // Not on a Worker. workerd's `node:fs` is an empty in-memory filesystem, so a local read
  // opened there "succeeds" and fails only after a 200 and its Content-Length have gone out: the
  // browser saves a truncated file. Unregistered, a record still pointing at local disk fails as
  // the registry's controlled "not available on this deployment" error before any byte is sent.
  // (Cutover step 12 verifies no such record remains.)
  if (!isWorkerRuntime()) {
    const local = new LocalObjectStore(getStorageProvider());
    storageRegistry.register({ objects: local, hierarchy: local });
  }

  // Google Drive appears only when the operator has turned it on. With the flag off,
  // nothing here is imported, no credential is read and no Google call is made — and a
  // record claiming to live in Drive fails loudly rather than silently falling back to
  // whatever stale local copy is still on disk (see the note in registry.ts).
  if (isDriveStorageEnabled()) {
    const drive = getGoogleDriveStorage().store;
    storageRegistry.register({ objects: drive, hierarchy: drive });
  }

  /**
   * `DEFAULT_STORAGE_PROVIDER` decides where *new* content goes. It is applied to the
   * registry here rather than read at each call site, and `setDefault` refuses a provider
   * that is not registered — so the configuration mistake this migration invites (pointing
   * the default at Drive on a deployment where Drive is not connected) fails at startup
   * instead of on somebody's upload.
   *
   * Note for Phase 6: the upload pipeline still writes through `getStorageProvider()`
   * (local quarantine → scan → originals) and does not yet consult this default. Setting it
   * to `google_drive` today changes what the registry reports, not where bytes land.
   */
  storageRegistry.setDefault(getEnv().DEFAULT_STORAGE_PROVIDER);
  registered = true;
}

/**
 * The store that owns a given record's bytes.
 *
 * Pass the record's own `storageProvider`. `null`/`undefined` resolves to local, which is
 * what every document written before this migration means.
 */
export function getObjectStore(name?: StorageProviderName | null): ObjectStore {
  registerProviders();
  return storageRegistry.resolve(name);
}

/** Where newly stored content goes, per configuration. */
export function getDefaultObjectStore(): ObjectStore {
  registerProviders();
  return storageRegistry.default();
}

export function getDefaultStorageProviderName(): StorageProviderName {
  registerProviders();
  return storageRegistry.defaultProviderName();
}

/** Test hook: inject a provider (e.g. an in-memory fake) and rebuild the registry from it. */
export function setStorageProvider(next: StorageProvider | null): void {
  provider = next;
  registered = false;
  storageRegistry.reset();
}

/** Test hook: forget the Drive registration too, so a suite can re-register from scratch. */
export function resetStorageRegistration(): void {
  registered = false;
  storageRegistry.reset();
}

export { LocalStorageProvider } from './local-provider';
export { LocalObjectStore } from './local-object-store';
export { StorageRegistry, storageRegistry } from './registry';
export {
  isDriveStorageEnabled,
  describeDriveStorage,
  checkDriveConnection,
  driveIsLoadBearing,
  GoogleDriveObjectStore,
} from './google';
export type { DriveConnectionHealth, DriveStorageConfigSummary } from './google';
export * from './types';
export * from './keys';
export {
  readBackupStatus,
  readRestoreDrillStatus,
  backupDirectory,
  BACKUP_STATUS_FILE,
  RESTORE_DRILL_STATUS_FILE,
} from './backup-status';
export type { BackupStatus, RestoreDrillStatus } from './backup-status';
export {
  assertSafeKey,
  resolveKey,
  sanitizeFilename,
  extractExtension,
  contentDisposition,
} from './path-safety';
