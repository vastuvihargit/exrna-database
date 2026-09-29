/**
 * "Never expose Google credentials or access tokens to the frontend."
 *
 * This file is the proof rather than the promise. The service-account key is a bearer
 * credential for every research file the company owns, so the assertions here are
 * structural — about which modules can reach it and which strings can appear in a client
 * bundle — not about any one handler remembering to omit a field.
 *
 * It also pins the second Phase 2 acceptance criterion: a deployment with the backend
 * switched off performs **no Google call at all**. That is not a performance nicety. A
 * deployment that quietly contacts Google when the operator has said not to is a
 * deployment whose configuration cannot be trusted to mean anything.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SRC = path.resolve(process.cwd(), 'src');

/** Every variable that is, or reveals, part of the Drive credential. */
const DRIVE_SECRET_VARIABLES = [
  'GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY',
  'GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE',
  'GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_SHARED_DRIVE_ID',
  'GOOGLE_DRIVE_ROOT_FOLDER_ID',
];

async function walk(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
    }),
  );
  return files.flat();
}

/** Everything that is compiled into the browser bundle: components, hooks, shared lib. */
async function clientReachableFiles(): Promise<string[]> {
  const dirs = [path.join(SRC, 'components'), path.join(SRC, 'hooks'), path.join(SRC, 'lib')];
  const listed = await Promise.all(dirs.map(walk));
  const fromDirs = listed.flat();

  // Plus any file anywhere that opts into the client runtime.
  const app = await walk(path.join(SRC, 'app'));
  const clientComponents: string[] = [];
  for (const file of app) {
    const source = await fsp.readFile(file, 'utf8');
    if (/^\s*['"]use client['"]/m.test(source)) clientComponents.push(file);
  }

  return [...fromDirs, ...clientComponents];
}

describe('the Drive credential cannot reach the browser', () => {
  it('names no Drive storage variable in any client-reachable module', async () => {
    const offenders: string[] = [];

    for (const file of await clientReachableFiles()) {
      const source = await fsp.readFile(file, 'utf8');
      for (const variable of DRIVE_SECRET_VARIABLES) {
        if (source.includes(variable)) offenders.push(`${path.relative(SRC, file)} → ${variable}`);
      }
    }

    expect(offenders, `Drive configuration referenced in client code: ${offenders.join(', ')}`).toEqual([]);
  });

  /**
   * `NEXT_PUBLIC_` is the one prefix Next inlines into the bundle at build time. A Drive
   * value behind it would be published to every visitor with no code change anywhere else
   * making that visible.
   */
  it('exposes no Drive value through a NEXT_PUBLIC_ variable', async () => {
    const offenders: string[] = [];
    const files = await walk(SRC);

    for (const file of files) {
      const source = await fsp.readFile(file, 'utf8');
      for (const match of source.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
        if (/GOOGLE|DRIVE|SERVICE_ACCOUNT/.test(match[0])) {
          offenders.push(`${path.relative(SRC, file)} → ${match[0]}`);
        }
      }
    }

    expect(offenders, `Drive values published to the browser: ${offenders.join(', ')}`).toEqual([]);
  });

  /**
   * The provider itself. `architecture-boundaries.test.ts` already forbids `@/server/storage`
   * imports from the UI; this states the Drive-specific case explicitly so that a future
   * relaxation of the general rule cannot quietly take this with it.
   */
  it('is not imported by any client-reachable module', async () => {
    const offenders: string[] = [];

    for (const file of await clientReachableFiles()) {
      const source = await fsp.readFile(file, 'utf8');
      if (/from ['"]@\/server\/storage[^'"]*['"]/.test(source) || /googleapis|google-auth-library/.test(source)) {
        offenders.push(path.relative(SRC, file));
      }
    }

    expect(offenders, `Storage internals reachable from the browser: ${offenders.join(', ')}`).toEqual([]);
  });

  /**
   * The credential is read in exactly one module. Keeping that true is what makes every
   * other assertion in this file a statement about the whole codebase rather than about
   * the places somebody thought to check.
   */
  it('is read in exactly one module', async () => {
    const files = await walk(SRC);
    const readers: string[] = [];

    for (const file of files) {
      const source = await fsp.readFile(file, 'utf8');
      if (source.includes('GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY')) readers.push(path.relative(SRC, file));
    }

    /**
     * `env.ts` declares it and `drive-config.ts` resolves it. Nothing else may touch it.
     *
     * `env.worker.ts` was added to this list in Cloudflare Phase 1, and only because it is
     * a *declaration* of the same kind as `env.ts` — the Worker runtime's environment
     * contract, which names the variable so it can be validated at boot and accepts the
     * longer `GOOGLE_DRIVE_*` spelling as an alias for the shorter `GOOGLE_*` one the
     * Worker uses. It does not read the key's value, pass it anywhere, or log it.
     *
     * **This list must not grow again without the same scrutiny.** The point of the
     * assertion is that a credential which appears in three files is one somebody can lose
     * track of; two declarations and one resolver is already the ceiling.
     */
    expect(readers.sort()).toEqual(
      [
        path.join('server', 'config', 'env.ts'),
        path.join('server', 'config', 'env.worker.ts'),
        path.join('server', 'storage', 'google', 'drive-config.ts'),
      ].sort(),
    );
  });
});

describe('a deployment with Drive switched off talks to nobody', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('makes no network request while resolving storage providers', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('a Google call was made on a deployment where Drive is disabled');
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const storage = await import('@/server/storage');
    storage.resetStorageRegistration();

    // Resolving the local provider is what every read on this deployment does.
    expect(storage.getObjectStore('local').provider).toBe('local');
    expect(storage.getDefaultStorageProviderName()).toBe('local');
    expect(storage.isDriveStorageEnabled()).toBe(false);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * And the failure is loud. A record claiming to live in Drive on a deployment without
   * Drive must not fall back to the retained local key: after a verified migration that
   * copy is exactly what an administrator is allowed to delete, so the read would work
   * today and start silently returning nothing later.
   */
  it('refuses to resolve a Drive-backed record rather than reading the local copy', async () => {
    const storage = await import('@/server/storage');
    storage.resetStorageRegistration();

    expect(() => storage.getObjectStore('google_drive')).toThrow(/not available on this deployment/i);
  });

  it('reports Drive as disabled in the health check without contacting Google', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('a Google call was made on a deployment where Drive is disabled');
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const { checkDriveConnection, resetDriveConnectionCache } = await import('@/server/storage/google/drive-health');
    resetDriveConnectionCache();

    const health = await checkDriveConnection();

    expect(health.enabled).toBe(false);
    expect(health.connected).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the public readiness probe reveals nothing about the Drive', () => {
  /**
   * `/api/health/ready` is polled by an orchestrator before any session exists, so it is
   * unauthenticated and therefore world-readable. Its Drive block is two booleans and a
   * status by construction — the identifiers an administrator needs live behind
   * `audit.view` on `/api/admin/storage/drive`.
   */
  it('has no field a drive id, name, or service account could occupy', async () => {
    const source = await fsp.readFile(path.join(SRC, 'server', 'health', 'health-service.ts'), 'utf8');
    const driveHealth = /export interface DriveHealth \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';

    expect(driveHealth).toBeTruthy();
    expect(driveHealth).not.toMatch(/driveId|driveName|sharedDrive|serviceAccount|rootFolder/i);

    // Exhaustive rather than a denylist: a new field added here has to be added to this
    // list too, which is the moment somebody asks whether it belongs on a world-readable
    // endpoint. `status` carries a severity — 'error' is a level, not a message.
    const fields = [...driveHealth.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((match) => match[1]);
    expect(fields.sort()).toEqual(['connected', 'enabled', 'status']);
  });
});
