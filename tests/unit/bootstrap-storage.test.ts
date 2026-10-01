/**
 * `bootstrap()` prepares the local storage tree only when uploads are staged on local disk.
 *
 * On a Worker (UPLOAD_STAGING=google_drive) there is no volume and workerd refuses `mkdir`
 * with "operation not permitted". Because the authenticated layout awaits `bootstrap()`,
 * that refusal used to take down every signed-in page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageProvider } from '@/server/storage';

const staging = vi.hoisted(() => ({ provider: 'local' as 'local' | 'google_drive' }));

// The marker package throws outside a React Server Component build.
vi.mock('server-only', () => ({}));

vi.mock('@/server/storage/staging', () => ({
  stagingProviderName: () => staging.provider,
}));

async function bootWith(provider: 'local' | 'google_drive') {
  staging.provider = provider;
  // `bootstrap()` memoizes on a module-level promise; a fresh module graph per case.
  vi.resetModules();
  const storage = await import('@/server/storage');
  const ensureReady = vi.fn(async () => {
    throw new Error('operation not permitted');
  });
  storage.setStorageProvider({ name: 'local', ensureReady } as unknown as StorageProvider);
  const { bootstrap } = await import('@/server/bootstrap');
  return { bootstrap, ensureReady, storage };
}

describe('bootstrap storage preparation', () => {
  let reset: (() => void) | null = null;

  afterEach(() => {
    reset?.();
    reset = null;
  });

  it('skips local folder creation when uploads are staged in Google Drive (Worker)', async () => {
    const { bootstrap, ensureReady, storage } = await bootWith('google_drive');
    reset = () => storage.setStorageProvider(null);

    await expect(bootstrap()).resolves.toBeUndefined();
    expect(ensureReady).not.toHaveBeenCalled();
  });

  it('still prepares, and fails loudly on, the local tree when staging is local', async () => {
    const { bootstrap, ensureReady, storage } = await bootWith('local');
    reset = () => storage.setStorageProvider(null);

    await expect(bootstrap()).rejects.toThrow('operation not permitted');
    expect(ensureReady).toHaveBeenCalledOnce();
  });
});
