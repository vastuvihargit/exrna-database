/**
 * The registry is the seam the whole local → Google Drive transition hangs on, so the
 * tests here are about its *refusals* as much as its lookups. Resolving to the wrong
 * provider does not throw an error a user would ever see — it serves the wrong bytes.
 */
import { describe, expect, it } from 'vitest';

import { StorageRegistry } from '@/server/storage/registry';
import type {
  HierarchicalStorageProvider,
  ObjectStore,
  StorageProviderName,
  StoredFileMetadata,
  StoredFolderResult,
  StoredObject,
} from '@/server/storage/types';

function fakeStore(provider: StorageProviderName): ObjectStore {
  return {
    provider,
    async read(): Promise<NodeJS.ReadableStream> {
      throw new Error('not used');
    },
    async exists() {
      return true;
    },
    async metadata(): Promise<StoredFileMetadata> {
      throw new Error('not used');
    },
    async remove() {},
    async copy(): Promise<StoredObject> {
      throw new Error('not used');
    },
  };
}

function fakeHierarchy(provider: StorageProviderName): HierarchicalStorageProvider {
  return {
    provider,
    async ensureFolder(): Promise<StoredFolderResult | null> {
      return null;
    },
    async renameItem() {},
    async moveItem() {},
    async trashItem() {},
    async restoreItem() {},
    async deleteItem() {},
    async itemExists() {
      return false;
    },
  };
}

function registryWith(...providers: StorageProviderName[]): StorageRegistry {
  const registry = new StorageRegistry();
  for (const provider of providers) {
    registry.register({ objects: fakeStore(provider), hierarchy: fakeHierarchy(provider) });
  }
  return registry;
}

describe('StorageRegistry — resolution', () => {
  it('resolves a registered provider by name', () => {
    const registry = registryWith('local', 'google_drive');
    expect(registry.resolve('local').provider).toBe('local');
    expect(registry.resolve('google_drive').provider).toBe('google_drive');
  });

  /**
   * Every FileVersion written before this migration has no `storageProvider` field. Those
   * documents must keep working with no backfill, so absent means local — here, once,
   * rather than at every call site.
   */
  it('treats an absent provider as local', () => {
    const registry = registryWith('local');
    expect(registry.resolve(undefined).provider).toBe('local');
    expect(registry.resolve(null).provider).toBe('local');
  });

  /**
   * The important one. A record claiming to live in Drive on a deployment where Drive is
   * not configured must fail loudly. Falling back to the local key would read whatever
   * stale copy happens to still be on disk and report it as a successful download.
   */
  it('refuses to resolve an unregistered provider instead of falling back', () => {
    const registry = registryWith('local');
    expect(() => registry.resolve('google_drive')).toThrow(/not available/i);
  });

  it('reports which providers are available', () => {
    const registry = registryWith('local');
    expect(registry.has('local')).toBe(true);
    expect(registry.has('google_drive')).toBe(false);
  });

  it('exposes the matching hierarchy provider for a name', () => {
    const registry = registryWith('local', 'google_drive');
    expect(registry.hierarchy('google_drive').provider).toBe('google_drive');
    expect(registry.hierarchy(undefined).provider).toBe('local');
  });

  it('refuses a registration whose two halves disagree about their provider', () => {
    const registry = new StorageRegistry();
    expect(() =>
      registry.register({ objects: fakeStore('local'), hierarchy: fakeHierarchy('google_drive') }),
    ).toThrow(/disagree/i);
  });
});

describe('StorageRegistry — default provider', () => {
  it('defaults to local', () => {
    const registry = registryWith('local');
    expect(registry.defaultProviderName()).toBe('local');
    expect(registry.default().provider).toBe('local');
  });

  it('can be pointed at another registered provider', () => {
    const registry = registryWith('local', 'google_drive');
    registry.setDefault('google_drive');
    expect(registry.default().provider).toBe('google_drive');
    // Existing local records still resolve — this is the dual-storage requirement.
    expect(registry.resolve('local').provider).toBe('local');
  });

  /**
   * Guards the configuration mistake this migration invites: setting
   * DEFAULT_STORAGE_PROVIDER=google_drive on a deployment where Drive is not connected.
   * Every subsequent upload would fail; failing at startup is the honest outcome.
   */
  it('refuses to default to a provider that is not registered', () => {
    const registry = registryWith('local');
    expect(() => registry.setDefault('google_drive')).toThrow(/not registered/i);
    expect(registry.defaultProviderName()).toBe('local');
  });

  it('reset returns it to an empty, local-defaulting state', () => {
    const registry = registryWith('local', 'google_drive');
    registry.setDefault('google_drive');
    registry.reset();

    expect(registry.defaultProviderName()).toBe('local');
    expect(registry.has('local')).toBe(false);
    expect(() => registry.resolve('local')).toThrow();
  });
});

describe('the local provider on a Worker', () => {
  /**
   * workerd's `node:fs` is an empty in-memory filesystem: a local read opens and then fails after
   * the 200 and its Content-Length are sent, so the browser saves a truncated file. Found in the
   * Worker preview. On a Worker the local provider is therefore never registered, and a record
   * still pointing at local disk fails before any byte is sent.
   */
  it('is not registered', async () => {
    const { setRuntimeOverride } = await import('@/server/runtime');
    const storage = await import('@/server/storage');
    setRuntimeOverride('workerd');
    storage.setStorageProvider(null);
    try {
      expect(() => storage.getObjectStore('local')).toThrow(/"local" storage provider/);
    } finally {
      setRuntimeOverride(null);
      storage.setStorageProvider(null);
    }
  });

  it('is registered on the Node deployment', async () => {
    const { setRuntimeOverride } = await import('@/server/runtime');
    const storage = await import('@/server/storage');
    setRuntimeOverride('node');
    storage.setStorageProvider(null);
    try {
      expect(storage.getObjectStore('local').provider).toBe('local');
    } finally {
      setRuntimeOverride(null);
      storage.setStorageProvider(null);
    }
  });
});
