import 'server-only';

import { getEnv } from '@/server/config/env';
import { getLogger } from '@/server/logging/logger';
import { getStorageProvider } from '@/server/storage';
import { stagingProviderName } from '@/server/storage/staging';

/**
 * One-time process bootstrap: validate configuration and prepare the private storage
 * tree so a misconfigured deployment fails with a clear message on first use rather
 * than at the first upload.
 *
 * Called from the authenticated layout and the readiness probe. It is memoized on a
 * promise, so concurrent requests share a single run and later requests are free.
 *
 * (A Next.js `instrumentation.ts` hook would run this earlier, but Next also compiles
 * that file for the edge runtime, where `fs`/`path` do not resolve.)
 */
let bootstrapPromise: Promise<void> | null = null;

async function run(): Promise<void> {
  // Throws with a field-by-field explanation if anything is missing or invalid.
  const env = getEnv();
  const log = getLogger();

  // A deployment without malware scanning is allowed, but never quietly: it is logged here at
  // startup, reported on the admin system page, and has to be chosen explicitly in a Worker.
  if (env.malwareScanMode === 'disabled') {
    log.warn(
      { malwareScanMode: 'disabled' },
      'Malware scanning is DISABLED: uploaded files are stored without being scanned',
    );
  }

  try {
    // Only a deployment that stages uploads on local disk has a storage tree to prepare. With
    // Drive staging (every Worker) there is no volume, and workerd refuses the mkdir outright —
    // which, thrown from the authenticated layout, took down every signed-in page. Same rule
    // as the readiness probe's storage check (health-service.ts).
    if (stagingProviderName() === 'local') {
      await getStorageProvider().ensureReady();
    }
    log.info(
      {
        environment: env.NODE_ENV,
        storageProvider: getStorageProvider().name,
        database: env.MONGODB_DATABASE,
      },
      'Biotech Research Drive ready',
    );
  } catch (error) {
    log.error({ err: error }, 'Storage initialization failed — file uploads will not work');
    throw error;
  }
}

export function bootstrap(): Promise<void> {
  bootstrapPromise ??= run().catch((error: unknown) => {
    // Do not cache a failed bootstrap: a fixed mount should recover without a restart.
    bootstrapPromise = null;
    throw error;
  });
  return bootstrapPromise;
}
