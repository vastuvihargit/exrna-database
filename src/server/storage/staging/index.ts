/**
 * Which staging backend an upload uses.
 *
 * ── `UPLOAD_STAGING` decides, and it is deliberately not `DEFAULT_STORAGE_PROVIDER` ─────
 *
 * The two look interchangeable and are not. `DEFAULT_STORAGE_PROVIDER=google_drive` means
 * "new content belongs in the Shared Drive", and the way it has always achieved that — write
 * locally, scan, record, hand off to Drive, keep the local copy for `LOCAL_COPY_RETENTION_DAYS`
 * — **is the rollback plan for the whole byte migration.** Collapsing the two settings would
 * have thrown that away for every deployment that had already turned Drive on, silently.
 *
 * `UPLOAD_STAGING=google_drive` is the separate, explicit decision to give it up: bytes go
 * straight into Drive and no local copy exists. A Worker has no filesystem, so it has no other
 * option, and `loadWorkerEnv` requires it there. On Node it stays opt-in.
 *
 * ── Failing closed ─────────────────────────────────────────────────────────────────────
 *
 * Asking for Drive on a deployment where Drive is not connected throws. It does **not** fall
 * back to local staging. A silent fallback is how a Worker deployment ends up trying to write
 * to a filesystem that does not exist, and the symptom would be every upload failing with an
 * `ENOENT` naming a directory nobody configured.
 */
import { getEnv } from '@/server/config/env';
import { StorageError } from '@/server/errors/app-error';
import { getGoogleDriveStorage, isDriveStorageEnabled } from '../google';
import { DriveUploadStaging } from './drive-staging';
import { LocalUploadStaging } from './local-staging';
import type { UploadStagingBackend } from './types';

let override: UploadStagingBackend | null = null;
let local: LocalUploadStaging | null = null;
let drive: DriveUploadStaging | null = null;

export function getUploadStaging(): UploadStagingBackend {
  if (override) return override;

  const env = getEnv();
  if (env.UPLOAD_STAGING === 'google_drive') {
    if (!isDriveStorageEnabled()) {
      throw new StorageError(
        'STORAGE_ERROR',
        'Uploads are configured to be staged in Google Drive (UPLOAD_STAGING=google_drive) but the ' +
          'Drive backend is not enabled on this deployment (GOOGLE_DRIVE_STORAGE_ENABLED=false).',
      );
    }
    if (!drive) {
      const { client, store } = getGoogleDriveStorage();
      drive = new DriveUploadStaging({ client, store });
    }
    return drive;
  }

  if (!local) local = new LocalUploadStaging();
  return local;
}

/** The provider newly staged content will be recorded under. Read by the health endpoint. */
export function stagingProviderName(): 'local' | 'google_drive' {
  return getUploadStaging().provider;
}

/** Test seam, mirroring `setStorageProvider()` and `setGoogleDriveStorage()`. */
export function setUploadStaging(next: UploadStagingBackend | null): void {
  override = next;
  if (next === null) {
    local = null;
    drive = null;
  }
}

export { LocalUploadStaging } from './local-staging';
export { DriveUploadStaging, offsetForChunk } from './drive-staging';
export { peekHead } from './peek-head';
export type {
  PromotedObject,
  PromotionTarget,
  StagedContent,
  StagedOutcome,
  StagingHandles,
  StagingSession,
  UploadStagingBackend,
} from './types';
