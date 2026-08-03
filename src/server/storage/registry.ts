/**
 * Provider registry — the one place that turns a stored provider name into code.
 *
 * Two rules, and both exist to make the local → Google Drive transition safe:
 *
 *   1. **An absent provider means `local`.** Every `FileVersion` written before this
 *      migration has no `storageProvider` field. Those documents must keep working
 *      untouched, so the null case is a supported input here rather than a backfill
 *      somewhere else.
 *
 *   2. **An unregistered provider throws.** If a record claims to live in Google Drive and
 *      Drive is not configured, the read fails loudly. It never falls back to the local
 *      key, which for a migrated file would serve a stale copy that happens to still be on
 *      disk — the worst possible outcome, because it looks like success.
 */
import { StorageError } from '@/server/errors/app-error';
import type { HierarchicalStorageProvider, ObjectStore, StorageProviderName } from './types';

interface RegisteredProvider {
  objects: ObjectStore;
  hierarchy: HierarchicalStorageProvider;
}

export class StorageRegistry {
  private readonly providers = new Map<StorageProviderName, RegisteredProvider>();
  private defaultProvider: StorageProviderName = 'local';

  register(entry: RegisteredProvider): void {
    if (entry.objects.provider !== entry.hierarchy.provider) {
      throw new StorageError(
        'STORAGE_ERROR',
        'Object store and hierarchy provider names disagree',
      );
    }
    this.providers.set(entry.objects.provider, entry);
  }

  /**
   * `null`/`undefined` is not a missing value — it is a document written before the
   * storage-provider field existed, and it means local. See rule 1 above.
   */
  resolve(name: StorageProviderName | null | undefined): ObjectStore {
    return this.entry(name ?? 'local').objects;
  }

  hierarchy(name: StorageProviderName | null | undefined): HierarchicalStorageProvider {
    return this.entry(name ?? 'local').hierarchy;
  }

  has(name: StorageProviderName): boolean {
    return this.providers.has(name);
  }

  /** Where new content goes. Read from configuration at registration time, never guessed. */
  setDefault(name: StorageProviderName): void {
    if (!this.providers.has(name)) {
      throw new StorageError(
        'STORAGE_ERROR',
        `Cannot default to the "${name}" storage provider: it is not registered`,
      );
    }
    this.defaultProvider = name;
  }

  defaultProviderName(): StorageProviderName {
    return this.defaultProvider;
  }

  default(): ObjectStore {
    return this.resolve(this.defaultProvider);
  }

  /** Test seam. */
  reset(): void {
    this.providers.clear();
    this.defaultProvider = 'local';
  }

  private entry(name: StorageProviderName): RegisteredProvider {
    const found = this.providers.get(name);
    if (!found) {
      throw new StorageError(
        'STORAGE_ERROR',
        `The "${name}" storage provider is not available on this deployment`,
      );
    }
    return found;
  }
}

export const storageRegistry = new StorageRegistry();
