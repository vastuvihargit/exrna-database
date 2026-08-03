/**
 * Google Shared Drive configuration — the only place the service-account credential is read.
 *
 * Nothing else in the codebase touches `GOOGLE_DRIVE_STORAGE_*`. That is the property that
 * makes "credentials never reach the frontend" structural rather than a code-review habit:
 * this module is under `@/server/storage`, which `architecture-boundaries.test.ts` already
 * forbids `components/` and `hooks/` from importing.
 *
 * ── Why a service account, and not the alternatives ────────────────────────────────────
 *
 * The service account is added as a **Content Manager member of the company Shared Drive**.
 * No domain-wide delegation, no interactive OAuth.
 *
 *   • *Domain-wide delegation* would let this key impersonate any employee in the Workspace
 *     domain. A leaked application-server environment variable would then be a full-domain
 *     compromise rather than a Drive compromise, and nothing here needs impersonation —
 *     MongoDB is the authoritative permission model (§13 of the brief).
 *   • *Admin-authorized OAuth* — which the inbound importer uses correctly, because that job
 *     is interactive and temporary — is wrong for a permanent storage backend. Refresh
 *     tokens die when the granting admin changes their password, resets sessions, or leaves.
 *     "All uploads stop company-wide because someone left" is not an acceptable failure mode.
 *   • *Service-account membership* has no such lifecycle, files it creates are owned by the
 *     Shared Drive (the organization) rather than a person, and access is revoked in one
 *     click by removing the member. Its effective reach is bounded by that membership: it
 *     can see exactly one Shared Drive and nothing else in the domain.
 *
 * The cost, stated plainly: this one key can read and write every research file. It is a
 * bearer credential, so `*_PRIVATE_KEY_FILE` (a mounted secret) takes precedence over the
 * inline variable and is the only supported form in production — an inline key is reported
 * as a warning on the admin system page rather than tolerated silently.
 */
import fs from 'fs';
import { getEnv } from '@/server/config/env';
import { StorageError } from '@/server/errors/app-error';

export interface DriveStorageConfig {
  /** The Shared Drive every object lives in. Never an individual's My Drive. */
  sharedDriveId: string;
  /** A folder inside that drive, or null for the drive's own root. */
  rootFolderId: string | null;
  serviceAccountEmail: string;
  /** PEM. Never logged, never serialized, never leaves this process. */
  privateKey: string;
  workspaceDomain: string | null;
  uploadChunkBytes: number;
  maxConcurrentTransfers: number;
  requestTimeoutMs: number;
  /** Which source the key came from — surfaced to admins, never the key itself. */
  keySource: 'file' | 'inline';
}

/**
 * What an administrator is allowed to see about the configuration.
 *
 * Deliberately a separate type from `DriveStorageConfig` with no field the private key
 * could be assigned to, so a serialization mistake cannot leak it.
 */
export interface DriveStorageConfigSummary {
  enabled: boolean;
  configured: boolean;
  sharedDriveId: string | null;
  rootFolderId: string | null;
  serviceAccountEmail: string | null;
  workspaceDomain: string | null;
  keySource: 'file' | 'inline' | null;
  defaultProvider: 'local' | 'google_drive';
  warnings: string[];
}

/** True when the operator has turned the backend on. Reading it performs no Google call. */
export function isDriveStorageEnabled(): boolean {
  return getEnv().GOOGLE_DRIVE_STORAGE_ENABLED;
}

/**
 * Normalizes a PEM from either source.
 *
 * `.env` files cannot carry real newlines, so an inline key arrives with literal `\n`
 * two-character sequences. A file-mounted key already has real ones. Both are accepted and
 * the shape is checked, because a truncated or base64-wrapped key otherwise fails much
 * later with an opaque `error:1E08010C:DECODER routines::unsupported`.
 */
function normalizePrivateKey(raw: string, source: 'file' | 'inline'): string {
  const key = raw.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();

  if (!key.includes('-----BEGIN') || !key.includes('PRIVATE KEY-----')) {
    throw new StorageError(
      'STORAGE_ERROR',
      `The Google Drive service-account key (${source}) is not a PEM private key. ` +
        'Copy the "private_key" value from the service account JSON, including the ' +
        '-----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY----- lines.',
    );
  }
  return key;
}

function readPrivateKey(): { key: string; source: 'file' | 'inline' } {
  const env = getEnv();
  const file = env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE?.trim();

  // File first, always: a deployment that mounts a secret *and* leaves a stale inline value
  // in its environment must use the secret, not whichever the code happened to check first.
  if (file) {
    let contents: string;
    try {
      contents = fs.readFileSync(file, 'utf8');
    } catch {
      // The path is not repeated in the message: it is a filesystem path, which this
      // codebase does not put into errors that can reach a log shipper.
      throw new StorageError(
        'STORAGE_ERROR',
        'The Google Drive service-account key file could not be read. Check that the secret is mounted and readable.',
      );
    }
    return { key: normalizePrivateKey(contents, 'file'), source: 'file' };
  }

  const inline = env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim();
  if (inline) return { key: normalizePrivateKey(inline, 'inline'), source: 'inline' };

  throw new StorageError(
    'STORAGE_ERROR',
    'No Google Drive service-account key is configured. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE.',
  );
}

let cached: DriveStorageConfig | null = null;

/**
 * The resolved configuration.
 *
 * Throws when the backend is disabled: every caller is inside a code path that has already
 * established Drive is in use, so a `null` return would only invite an unchecked
 * dereference. `env.ts` has already refused to boot if the flag is on and a required value
 * is missing, so the failures reachable here are the ones it cannot see — an unreadable
 * secret mount and a malformed key.
 */
export function getDriveStorageConfig(): DriveStorageConfig {
  if (cached) return cached;

  const env = getEnv();
  if (!env.GOOGLE_DRIVE_STORAGE_ENABLED) {
    throw new StorageError(
      'STORAGE_ERROR',
      'Google Drive storage is not enabled on this deployment (GOOGLE_DRIVE_STORAGE_ENABLED=false)',
    );
  }

  const { key, source } = readPrivateKey();

  cached = {
    sharedDriveId: env.GOOGLE_SHARED_DRIVE_ID!,
    rootFolderId: env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim() || null,
    serviceAccountEmail: env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL!,
    privateKey: key,
    workspaceDomain: env.GOOGLE_WORKSPACE_DOMAIN?.trim().toLowerCase() || null,
    uploadChunkBytes: env.googleDriveUploadChunkBytes,
    maxConcurrentTransfers: env.GOOGLE_DRIVE_MAX_CONCURRENT_TRANSFERS,
    requestTimeoutMs: env.GOOGLE_DRIVE_REQUEST_TIMEOUT_MS,
    keySource: source,
  };
  return cached;
}

/**
 * The admin-safe view. Never throws — an unreadable key is *reported*, because the admin
 * page whose job is to explain a broken connection must not itself fail to render.
 */
export function describeDriveStorage(): DriveStorageConfigSummary {
  const env = getEnv();
  const base: DriveStorageConfigSummary = {
    enabled: env.GOOGLE_DRIVE_STORAGE_ENABLED,
    configured: false,
    sharedDriveId: null,
    rootFolderId: null,
    serviceAccountEmail: null,
    workspaceDomain: null,
    keySource: null,
    defaultProvider: env.DEFAULT_STORAGE_PROVIDER,
    warnings: [],
  };

  if (!base.enabled) return base;

  try {
    const config = getDriveStorageConfig();
    const warnings: string[] = [];

    if (config.keySource === 'inline' && env.isProduction) {
      warnings.push(
        'The service-account key is set inline in the environment. In production it should be a mounted ' +
          'secret (GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE) so it is not visible to anything that can ' +
          'read the process environment.',
      );
    }
    if (!config.rootFolderId) {
      warnings.push(
        'No root folder is set, so content is written to the top level of the Shared Drive. ' +
          'A dedicated folder is easier to audit and to scope.',
      );
    }

    return {
      ...base,
      configured: true,
      sharedDriveId: config.sharedDriveId,
      rootFolderId: config.rootFolderId,
      serviceAccountEmail: config.serviceAccountEmail,
      workspaceDomain: config.workspaceDomain,
      keySource: config.keySource,
      warnings,
    };
  } catch (error) {
    return {
      ...base,
      warnings: [error instanceof Error ? error.message : 'The Google Drive configuration is invalid.'],
    };
  }
}

/** Test-only: drop the memoized configuration so a test can re-read a mutated process.env. */
export function resetDriveStorageConfigCache(): void {
  cached = null;
}
