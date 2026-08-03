/**
 * "Can this deployment actually reach its Shared Drive, and write to it?"
 *
 * Answered with metadata calls only — never by writing a probe object. A health check that
 * creates and deletes a file in company storage on every readiness poll would put churn
 * into the Drive activity log that administrators have to learn to ignore, and would burn
 * API quota that interactive uploads share.
 *
 * The result is cached briefly because `/api/health/ready` is polled by an orchestrator on
 * a short interval and the answer does not change second to second. A failure is cached for
 * a much shorter time than a success: when the connection is broken, an administrator is
 * usually standing over the page waiting to see it come back.
 */
import { getEnv } from '@/server/config/env';
import { describeDriveStorage, isDriveStorageEnabled } from './drive-config';
import { GOOGLE_FOLDER_MIME, type DriveClient } from './drive-client';
import { DriveApiError } from './drive-errors';

export interface DriveConnectionHealth {
  enabled: boolean;
  /** Reachable *and* usable. A drive we can see but not write to is not connected. */
  connected: boolean;
  driveName: string | null;
  canAddContent: boolean | null;
  /** Null when no root folder is configured, so nothing needed checking. */
  rootFolderOk: boolean | null;
  /** Admin-facing; safe to show an administrator, never an employee. */
  error: string | null;
  checkedAt: Date;
}

const SUCCESS_TTL_MS = 60_000;
const FAILURE_TTL_MS = 10_000;

let cache: { value: DriveConnectionHealth; expiresAt: number } | null = null;

function disabled(): DriveConnectionHealth {
  return {
    enabled: false,
    connected: false,
    driveName: null,
    canAddContent: null,
    rootFolderOk: null,
    error: null,
    checkedAt: new Date(),
  };
}

/**
 * Runs the two checks that catch the configuration mistakes people actually make.
 *
 * 1. `drives.get` — the service account is a member of this Shared Drive and can see it.
 *    A 404 here almost always means "the key is fine, but nobody added it as a member",
 *    which is invisible from the Google Cloud console and is the single most common
 *    first-time failure.
 * 2. The configured root folder is a folder, and is **inside that same drive**. Pasting a
 *    folder id from a different drive — or from somebody's My Drive — otherwise produces a
 *    deployment that appears healthy and quietly writes company research into a personal
 *    account.
 */
export async function checkDriveConnectionWith(
  client: DriveClient,
  sharedDriveId: string,
  rootFolderId: string | null,
): Promise<DriveConnectionHealth> {
  const checkedAt = new Date();

  let driveName: string | null = null;
  let canAddContent: boolean | null = null;

  try {
    const drive = await client.getDrive(sharedDriveId);
    driveName = drive.name;
    canAddContent = drive.capabilities?.canAddChildren ?? null;
  } catch (error) {
    return {
      enabled: true,
      connected: false,
      driveName: null,
      canAddContent: null,
      rootFolderOk: null,
      error: describeFailure(error, 'The Shared Drive could not be opened'),
      checkedAt,
    };
  }

  if (canAddContent === false) {
    return {
      enabled: true,
      connected: false,
      driveName,
      canAddContent: false,
      rootFolderOk: null,
      error:
        'The service account can see the Shared Drive but cannot add content to it. Change its membership to Content Manager.',
      checkedAt,
    };
  }

  if (!rootFolderId) {
    return { enabled: true, connected: true, driveName, canAddContent, rootFolderOk: null, error: null, checkedAt };
  }

  try {
    const folder = await client.getFile(rootFolderId);

    if (folder.mimeType !== GOOGLE_FOLDER_MIME) {
      return failedRoot(driveName, canAddContent, 'The configured root is a file, not a folder.', checkedAt);
    }
    if (folder.driveId && folder.driveId !== sharedDriveId) {
      return failedRoot(
        driveName,
        canAddContent,
        'The configured root folder belongs to a different drive. Company files must stay inside the configured Shared Drive.',
        checkedAt,
      );
    }
    if (!folder.driveId) {
      // No `driveId` means the item is not in a Shared Drive at all — i.e. it is in some
      // account's My Drive. That is the exact arrangement this design exists to prevent.
      return failedRoot(
        driveName,
        canAddContent,
        'The configured root folder is not inside a Shared Drive. Company storage must not live in an individual account.',
        checkedAt,
      );
    }
    if (folder.trashed) {
      return failedRoot(driveName, canAddContent, 'The configured root folder is in the Drive trash.', checkedAt);
    }

    return { enabled: true, connected: true, driveName, canAddContent, rootFolderOk: true, error: null, checkedAt };
  } catch (error) {
    return failedRoot(
      driveName,
      canAddContent,
      describeFailure(error, 'The configured root folder could not be opened'),
      checkedAt,
    );
  }
}

function failedRoot(
  driveName: string | null,
  canAddContent: boolean | null,
  error: string,
  checkedAt: Date,
): DriveConnectionHealth {
  return { enabled: true, connected: false, driveName, canAddContent, rootFolderOk: false, error, checkedAt };
}

/**
 * Google's own message is kept for an administrator, because it is genuinely diagnostic
 * ("File not found: 0AB…"). This value only ever reaches the admin surfaces, which are
 * gated on company-scoped `audit.view`.
 */
function describeFailure(error: unknown, fallback: string): string {
  if (error instanceof DriveApiError) {
    if (error.status === 404) {
      return `${fallback}: not found. Check the id, and that the service account has been added as a member of the Shared Drive.`;
    }
    if (error.status === 403) {
      return `${fallback}: access denied. The service account is not a member of this drive, or lacks Content Manager rights.`;
    }
    return `${fallback}: ${error.message}`;
  }
  return error instanceof Error ? `${fallback}: ${error.message}` : fallback;
}

/**
 * The cached, application-wide check.
 *
 * Performs no Google call at all when the backend is disabled — which is the Phase 2
 * acceptance criterion, and the reason the flag is consulted before the client is even
 * constructed.
 */
export async function checkDriveConnection(options?: { force?: boolean }): Promise<DriveConnectionHealth> {
  if (!isDriveStorageEnabled()) return disabled();

  const now = Date.now();
  if (!options?.force && cache && cache.expiresAt > now) return cache.value;

  const summary = describeDriveStorage();
  if (!summary.configured || !summary.sharedDriveId) {
    const value: DriveConnectionHealth = {
      enabled: true,
      connected: false,
      driveName: null,
      canAddContent: null,
      rootFolderOk: null,
      error: summary.warnings[0] ?? 'Google Drive storage is not fully configured.',
      checkedAt: new Date(),
    };
    cache = { value, expiresAt: now + FAILURE_TTL_MS };
    return value;
  }

  // Imported lazily so that a deployment with the flag off never even constructs the client.
  const { getGoogleDriveStorage } = await import('./index');
  const value = await checkDriveConnectionWith(
    getGoogleDriveStorage().client,
    summary.sharedDriveId,
    summary.rootFolderId,
  );

  cache = { value, expiresAt: now + (value.connected ? SUCCESS_TTL_MS : FAILURE_TTL_MS) };
  return value;
}

/** Whether an unreachable Drive is an outage or merely a warning on this deployment. */
export function driveIsLoadBearing(): boolean {
  return isDriveStorageEnabled() && getEnv().DEFAULT_STORAGE_PROVIDER === 'google_drive';
}

/** Test-only. */
export function resetDriveConnectionCache(): void {
  cache = null;
}
