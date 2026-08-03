/**
 * Google Shared Drive storage — assembly point.
 *
 * Construction is lazy and performs no network call, which is what lets the storage
 * registry decide whether Drive exists at all without a boot-time dependency on Google
 * being reachable. A deployment with `GOOGLE_DRIVE_STORAGE_ENABLED=false` never reaches
 * any of this.
 */
import { getDriveStorageConfig } from './drive-config';
import { ServiceAccountTokenSource } from './drive-auth';
import { GoogleDriveHttpClient, type DriveClient } from './drive-client';
import { GoogleDriveObjectStore } from './google-drive-object-store';

export interface GoogleDriveStorage {
  store: GoogleDriveObjectStore;
  client: DriveClient;
}

let instance: GoogleDriveStorage | null = null;

export function getGoogleDriveStorage(): GoogleDriveStorage {
  if (!instance) {
    const config = getDriveStorageConfig();
    const client = new GoogleDriveHttpClient(config, new ServiceAccountTokenSource(config));
    instance = { client, store: new GoogleDriveObjectStore(client, config) };
  }
  return instance;
}

/**
 * Test seam. Mirrors `setStorageProvider()` in the parent module: an in-memory Drive fake
 * is injected here and every layer above — provider, health check, and from Phase 5 the
 * migration worker — runs against it with no network and no Google account.
 */
export function setGoogleDriveStorage(next: GoogleDriveStorage | null): void {
  instance = next;
}

export { isDriveStorageEnabled, getDriveStorageConfig, describeDriveStorage, resetDriveStorageConfigCache } from './drive-config';
export type { DriveStorageConfig, DriveStorageConfigSummary } from './drive-config';
export { GoogleDriveObjectStore } from './google-drive-object-store';
export {
  GoogleDriveHttpClient,
  GOOGLE_FOLDER_MIME,
  GOOGLE_NATIVE_EXPORT_FORMATS,
  DRIVE_FILE_FIELDS,
  DRIVE_REVISION_FIELDS,
  isGoogleNativeMimeType,
  escapeDriveQueryValue,
} from './drive-client';
export type {
  DriveChange,
  DriveChangePage,
  DriveClient,
  DriveFileResource,
  DriveListPage,
  DriveResource,
  DriveRevisionResource,
  DriveUpdateInput,
  DriveUploadInput,
} from './drive-client';
export {
  DriveApiError,
  isRetryableDriveFailure,
  isAuthFailure,
  isNotFound,
  backoffDelayMs,
  withDriveRetry,
  driveErrorFromResponse,
} from './drive-errors';
export {
  checkDriveConnection,
  checkDriveConnectionWith,
  driveIsLoadBearing,
  resetDriveConnectionCache,
} from './drive-health';
export type { DriveConnectionHealth } from './drive-health';
export { DRIVE_STORAGE_SCOPE, ServiceAccountTokenSource } from './drive-auth';
export type { AccessTokenSource } from './drive-auth';
