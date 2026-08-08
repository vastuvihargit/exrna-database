/**
 * File-version repository — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_FILE_VERSIONS`, using the flag that has existed in
 * `data-source.ts` since the phase began. MongoDB is the default and stays the default: an
 * unset variable, a typo, and a misspelled module name all resolve to it, so the only way to
 * read versions from D1 is to ask for it by name.
 *
 * **There is no fallback.** A D1 error propagates rather than being retried against MongoDB. A
 * silent fallback would mean an operator believing they were soaking D1 while some reads came
 * from MongoDB, and the first symptom would be a migration signed off on evidence that was
 * never collected.
 *
 * ── One thing this façade cannot route ──────────────────────────────────────────────────
 *
 * Creating a version writes a `file_versions` row *and* repoints `files.current_version_id`.
 * Those are two repositories, so no single method here can make them atomic — and on D1 the
 * `withTransaction` the services wrap them in is a MongoDB session that governs neither. That
 * composition lives in `d1-unit-of-work.ts` as `createVersionWithFile`, and
 * `versionsAndFilesEngine()` is what refuses to attempt it when the two modules are on
 * different databases. See §6 of the module document.
 *
 * The dispatch is per call rather than cached at module load, so flipping the variable takes
 * effect on the next request without a restart.
 */
import { getLogger } from '@/server/logging/logger';
import { isD1 } from './data-source';
import { mongoFileVersionRepository } from './file-version.repository.mongo';
import { d1FileVersionRepository } from './file-version.repository.d1';
import type {
  CreateVersionInput,
  FileVersionRepository,
  StoredObjectRef,
  VersionApprovalBinding,
  VersionByDriveId,
  VersionPatch,
  VersionRecord,
  VersionStorageLocation,
  VersionTx,
} from './file-version.repository.contract';
import type { StorageLocator } from '@/server/storage/types';

export type {
  CreateVersionInput,
  FileVersionRepository,
  StoredObjectRef,
  VersionApprovalBinding,
  VersionByDriveId,
  VersionPatch,
  VersionRecord,
  VersionStorageLocation,
  VersionTx,
};

/** Re-exported so a parity test can assert the two agree without importing both by path. */
export { mongoFileVersionRepository, d1FileVersionRepository };

let announced: 'mongo' | 'd1' | null = null;

function active(): FileVersionRepository {
  const d1 = isD1('fileVersions');
  const selected = d1 ? 'd1' : 'mongo';
  if (announced !== selected) {
    announced = selected;
    getLogger().info(
      { module: 'fileVersions', dataSource: selected },
      'File-version repository selected',
    );
  }
  return d1 ? d1FileVersionRepository : mongoFileVersionRepository;
}

/* -------------------------------------------------- reads */

export async function findById(id: string): Promise<VersionRecord | null> {
  return active().findById(id);
}

export async function listForFile(fileId: string): Promise<VersionRecord[]> {
  return active().listForFile(fileId);
}

export async function findCurrent(fileId: string): Promise<VersionRecord | null> {
  return active().findCurrent(fileId);
}

export async function nextVersionNumber(fileId: string): Promise<number> {
  return active().nextVersionNumber(fileId);
}

export async function getStorageLocation(
  versionId: string,
): Promise<VersionStorageLocation | null> {
  return active().getStorageLocation(versionId);
}

export async function getStorageLocationsForFiles(fileIds: string[]): Promise<StorageLocator[]> {
  return active().getStorageLocationsForFiles(fileIds);
}

export async function findByDriveFileId(
  googleDriveFileId: string,
): Promise<VersionByDriveId | null> {
  return active().findByDriveFileId(googleDriveFileId);
}

export async function listDriveBackedVersions(input: {
  limit: number;
  afterId?: string | null;
}): Promise<Array<{ versionId: string; fileId: string; googleDriveFileId: string }>> {
  return active().listDriveBackedVersions(input);
}

export async function getApprovalBinding(
  versionId: string,
): Promise<VersionApprovalBinding | null> {
  return active().getApprovalBinding(versionId);
}

export async function listLiveRemoteApprovals(input: {
  limit: number;
  afterId?: string | null;
}): Promise<VersionApprovalBinding[]> {
  return active().listLiveRemoteApprovals(input);
}

export async function listStoredObjects(input: {
  afterId?: string;
  limit: number;
}): Promise<StoredObjectRef[]> {
  return active().listStoredObjects(input);
}

/* -------------------------------------------------- counters */

export async function countSyncConflicts(): Promise<number> {
  return active().countSyncConflicts();
}

export async function countLiveRemoteApprovals(): Promise<number> {
  return active().countLiveRemoteApprovals();
}

export async function countSupersededApprovals(): Promise<number> {
  return active().countSupersededApprovals();
}

export async function countStoredObjects(): Promise<number> {
  return active().countStoredObjects();
}

/* -------------------------------------------------- writes */

export function newId(): string {
  return active().newId();
}

export async function create(
  input: CreateVersionInput,
  tx?: VersionTx,
): Promise<VersionRecord> {
  return active().create(input, tx);
}

export async function setCurrent(
  fileId: string,
  versionId: string,
  tx?: VersionTx,
): Promise<void> {
  return active().setCurrent(fileId, versionId, tx);
}

export async function updateFlags(
  versionId: string,
  patch: VersionPatch,
  tx?: VersionTx,
): Promise<void> {
  return active().updateFlags(versionId, patch, tx);
}

export async function markStorageConflict(versionId: string, reason: string): Promise<void> {
  return active().markStorageConflict(versionId, reason);
}

export async function purgeForFiles(fileIds: string[]): Promise<number> {
  return active().purgeForFiles(fileIds);
}
