/**
 * Creates the private storage directory tree and verifies it is writable.
 * Run once when provisioning a host or after attaching a new volume.
 */
import './load-dotenv';

import { loadEnv } from '../src/server/config/env';
import { LocalStorageProvider } from '../src/server/storage/local-provider';
import { Readable } from 'node:stream';

async function main() {
  const env = loadEnv();
  const provider = new LocalStorageProvider({
    storage: env.storageRoots.storage,
    temp: env.storageRoots.temp,
    quarantine: env.storageRoots.quarantine,
    previews: env.storageRoots.previews,
    exports: env.storageRoots.exports,
  });

  await provider.ensureReady();
  console.log('✓ Storage directories created');
  for (const [name, root] of Object.entries(env.storageRoots)) {
    console.log(`  ${name.padEnd(10)} ${root}`);
  }

  // Prove writability rather than assuming it — a read-only mount fails here, not at
  // the first user upload.
  const probeKey = `init-check/probe-${Date.now()}`;
  const payload = Buffer.from('storage-writable');
  const saved = await provider.saveFile({
    key: probeKey,
    area: 'temporary',
    body: Readable.from(payload),
    expectedSize: payload.byteLength,
  });
  await provider.deleteFile(probeKey, 'temporary');
  console.log(`✓ Storage is writable (probe checksum ${saved.checksumSha256.slice(0, 12)}…)`);

  const capacity = await provider.getCapacity('originals').catch(() => null);
  if (capacity) {
    const freeGb = (capacity.freeBytes / 1024 ** 3).toFixed(1);
    const totalGb = (capacity.totalBytes / 1024 ** 3).toFixed(1);
    console.log(`✓ Capacity: ${freeGb} GB free of ${totalGb} GB`);
    if (capacity.freeBytes < env.minFreeDiskBytes) {
      console.warn(`⚠ Free space is below MIN_FREE_DISK_GB (${env.MIN_FREE_DISK_GB} GB) — uploads will be refused`);
    }
  }
}

main().catch((error: unknown) => {
  console.error('✗ Storage initialization failed');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
