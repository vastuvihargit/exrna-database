/**
 * Health reporting for /api/health/ready.
 *
 * Checks the two stateful dependencies the application cannot work without:
 * the database, and a *writable* private storage volume. Writability is verified by
 * actually writing and reading a probe file — a mount that has silently become
 * read-only (or disappeared after a container restart) is the failure this catches.
 */
import { Readable } from 'stream';
import { getEnv } from '@/server/config/env';
import { checkDatabaseHealth, type DatabaseHealth } from '@/server/db/connection';
import { checkDriveConnection, driveIsLoadBearing, getStorageProvider, isDriveStorageEnabled } from '@/server/storage';
import { LocalStorageProvider } from '@/server/storage/local-provider';
import { stagingProviderName } from '@/server/storage/staging';

export interface StorageHealth {
  status: 'ok' | 'degraded' | 'error';
  provider: string;
  writable: boolean;
  totalBytes?: number;
  freeBytes?: number;
  freePercent?: number;
  belowFreeSpaceFloor?: boolean;
  error?: string;
}

/**
 * The Drive half of the readiness report.
 *
 * Three booleans and a status, and nothing else — no drive id, no drive name, no service
 * account address, no Google error text. `/api/health/ready` is unauthenticated by design
 * (an orchestrator polls it before any session exists), so everything here is world
 * readable. The identifiers an administrator needs to diagnose a broken connection live on
 * `/api/admin/storage/drive`, behind company-scoped `audit.view`.
 */
export interface DriveHealth {
  status: 'disabled' | 'ok' | 'degraded' | 'error';
  enabled: boolean;
  connected: boolean;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  uptimeSeconds: number;
  environment: string;
  checks: {
    database: DatabaseHealth;
    storage: StorageHealth;
    drive: DriveHealth;
  };
}

/**
 * An unreachable Drive is only an *outage* once Drive is where new content goes.
 *
 * While `DEFAULT_STORAGE_PROVIDER=local` — every deployment today — a broken Drive
 * connection blocks migration and nothing else, so it must not take the instance out of
 * the load balancer and stop employees working on local files that are fine. Once the
 * default flips, the same failure means uploads are refused, and 503 is then correct.
 */
async function checkDriveHealth(): Promise<DriveHealth> {
  if (!isDriveStorageEnabled()) {
    return { status: 'disabled', enabled: false, connected: false };
  }

  const health = await checkDriveConnection().catch(() => null);
  const connected = health?.connected ?? false;

  return {
    status: connected ? 'ok' : driveIsLoadBearing() ? 'error' : 'degraded',
    enabled: true,
    connected,
  };
}

/**
 * The writable-volume probe.
 *
 * **Only meaningful when uploads are staged locally.** The probe writes a file, reads it back
 * and deletes it, which is exactly the right check for a mount that has silently become
 * read-only after a container restart. It is the wrong check — and an impossible one — when
 * staging is Google Drive and there is no volume: `getStorageProvider()` would construct a
 * local provider against directories nothing has ever created, and report `provider: "local"`
 * on a deployment that writes nothing to a disk.
 *
 * That string is the first thing an operator reads after a deploy, so being wrong about it is
 * not cosmetic. When staging is external the report says so and defers to the Drive check,
 * which is the dependency that actually gates uploads.
 */
async function checkStorageHealth(): Promise<StorageHealth> {
  const env = getEnv();

  if (stagingProviderName() !== 'local') {
    return {
      status: 'ok',
      provider: stagingProviderName(),
      // Not "assumed true": the Drive connection check below is the real writability probe for
      // this configuration, and it fails the whole report if the service account cannot write.
      writable: true,
    };
  }

  const provider = getStorageProvider();

  try {
    await provider.ensureReady();

    // Round-trip probe: write, read back, delete. Uses the temporary area so a
    // failure never touches research data.
    const probeKey = `healthcheck/probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const payload = Buffer.from('biotech-drive-health-probe');

    const saved = await provider.saveFile({
      key: probeKey,
      area: 'temporary',
      body: Readable.from(payload),
      expectedSize: payload.byteLength,
    });

    const stream = await provider.getFile(probeKey, 'temporary');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    const readBack = Buffer.concat(chunks);
    await provider.deleteFile(probeKey, 'temporary');

    const roundTripOk = readBack.equals(payload) && saved.size === payload.byteLength;
    if (!roundTripOk) {
      return { status: 'error', provider: provider.name, writable: false, error: 'Storage round-trip verification failed' };
    }

    let capacity: { totalBytes: number; freeBytes: number } | null = null;
    if (provider instanceof LocalStorageProvider) {
      capacity = await provider.getCapacity('originals').catch(() => null);
    }

    if (!capacity) {
      return { status: 'ok', provider: provider.name, writable: true };
    }

    const freePercent = capacity.totalBytes > 0 ? (capacity.freeBytes / capacity.totalBytes) * 100 : 0;
    const belowFloor = capacity.freeBytes < env.minFreeDiskBytes;

    return {
      status: belowFloor ? 'degraded' : 'ok',
      provider: provider.name,
      writable: true,
      totalBytes: capacity.totalBytes,
      freeBytes: capacity.freeBytes,
      freePercent: Math.round(freePercent * 10) / 10,
      belowFreeSpaceFloor: belowFloor,
    };
  } catch (error) {
    return {
      status: 'error',
      provider: provider.name,
      writable: false,
      // Storage errors are deliberately generic — their messages can contain paths.
      error: 'Storage is not writable',
      ...(getEnv().isDevelopment && error instanceof Error ? { error: error.message } : {}),
    };
  }
}

export async function getHealthReport(): Promise<HealthReport> {
  const env = getEnv();
  const [database, storage, drive] = await Promise.all([
    checkDatabaseHealth(),
    checkStorageHealth(),
    checkDriveHealth(),
  ]);

  const anyError = database.status === 'error' || storage.status === 'error' || drive.status === 'error';
  const anyDegraded = storage.status === 'degraded' || drive.status === 'degraded';

  const status: HealthReport['status'] = anyError ? 'error' : anyDegraded ? 'degraded' : 'ok';

  return {
    status,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    environment: env.NODE_ENV,
    checks: { database, storage, drive },
  };
}
