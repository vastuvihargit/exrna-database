/**
 * File repository — a façade over the MongoDB and (eventually) D1 implementations.
 *
 * Routed by `DATA_SOURCE_FILES`. MongoDB is the default and stays the default: an unset
 * variable, a typo, and a misspelled module name all resolve to it (`data-source.ts`), so the
 * only way to read files from anywhere else is to ask for it by name.
 *
 * **There is no fallback.** A D1 error propagates rather than being retried against MongoDB.
 * A silent fallback would mean an operator believing they were soaking D1 while some or all
 * reads came from MongoDB, and the first symptom would be a migration signed off on evidence
 * that was never collected.
 *
 * Until Phase 3 module 6 landed `file.repository.d1.ts`, asking for D1 raised
 * `D1FileRepositoryUnavailableError` for the same reason. The implementation now exists, so the
 * flag resolves normally and that error is gone; what has not changed is that nothing silently
 * substitutes one database for the other.
 *
 * The dispatch is per call rather than cached at module load, so flipping the variable takes
 * effect on the next request without a restart.
 *
 * Which implementation was selected is logged once per process per value, at info — enough to
 * answer "which database served this?" from the logs of an incident, not enough to be noise.
 */
import { getLogger } from '@/server/logging/logger';
import { isD1 } from './data-source';
import { mongoFileRepository } from './file.repository.mongo';
import { d1FileRepository } from './file.repository.d1';
import type {
  AclEntryWrite,
  CreateFileInput,
  FileGuard,
  FileHierarchyProblem,
  FilePage,
  FilePatch,
  FileRecord,
  FileRepository,
  FileSortField,
  FileTx,
  FindRelatedInput,
  ListForActorInput,
  ListInFolderInput,
  ListSharedWithInput,
  ProjectContentBreakdown,
  ReparentSubtreeInput,
  SearchFacets,
  SearchFilesInput,
} from './file.repository.contract';
import type { Actor } from '@/server/permissions/actor';

export type {
  AclEntryWrite,
  CreateFileInput,
  FileGuard,
  FileHierarchyProblem,
  FilePage,
  FilePatch,
  FileRecord,
  FileRepository,
  FileSortField,
  FileTx,
  FindRelatedInput,
  ListForActorInput,
  ListInFolderInput,
  ListSharedWithInput,
  ProjectContentBreakdown,
  ReparentSubtreeInput,
  SearchFacets,
  SearchFilesInput,
};

/** Re-exported so a test can assert the two paths agree without importing both by path. */
export { mongoFileRepository, d1FileRepository };

let announced: 'mongo' | 'd1' | null = null;

function active(): FileRepository {
  const d1 = isD1('files');
  const selected = d1 ? 'd1' : 'mongo';
  if (announced !== selected) {
    announced = selected;
    getLogger().info({ module: 'files', dataSource: selected }, 'File repository selected');
  }
  return d1 ? d1FileRepository : mongoFileRepository;
}

/* -------------------------------------------------- permission-aware reads */

export async function findById(
  actor: Actor,
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<FileRecord | null> {
  return active().findById(actor, id, options);
}

export async function findByIds(actor: Actor, ids: string[]): Promise<FileRecord[]> {
  return active().findByIds(actor, ids);
}

export async function listInFolder(input: ListInFolderInput): Promise<FilePage> {
  return active().listInFolder(input);
}

export async function listTrashed(input: ListForActorInput): Promise<FilePage> {
  return active().listTrashed(input);
}

export async function search(input: SearchFilesInput): Promise<FilePage> {
  return active().search(input);
}

export async function listSharedWith(input: ListSharedWithInput): Promise<FilePage> {
  return active().listSharedWith(input);
}

export async function searchFacets(actor: Actor): Promise<SearchFacets> {
  return active().searchFacets(actor);
}

export async function findRelated(input: FindRelatedInput): Promise<FileRecord[]> {
  return active().findRelated(input);
}

export async function projectContentBreakdown(
  actor: Actor,
  projectId: string,
): Promise<ProjectContentBreakdown> {
  return active().projectContentBreakdown(actor, projectId);
}

/* -------------------------------------------------- structural reads */

export async function existsWithName(
  folderId: string,
  displayNameLower: string,
  excludeId?: string,
): Promise<boolean> {
  return active().existsWithName(folderId, displayNameLower, excludeId);
}

export async function takenNamesInFolder(folderId: string): Promise<Set<string>> {
  return active().takenNamesInFolder(folderId);
}

export async function findByChecksumInFolder(
  folderId: string,
  checksum: string,
): Promise<FileRecord | null> {
  return active().findByChecksumInFolder(folderId, checksum);
}

export async function countInFolder(folderId: string): Promise<number> {
  return active().countInFolder(folderId);
}

export async function countForExperiment(experimentId: string): Promise<number> {
  return active().countForExperiment(experimentId);
}

/* -------------------------------------------------- authorization bypasses */

/**
 * ⚠️ Authorization bypass. Trusted server services only — see the contract for the callers
 * that legitimately need one and why an API route never does.
 */
export async function findByIdInternal(
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<FileRecord | null> {
  return active().findByIdInternal(id, options);
}

/** ⚠️ Authorization bypass: subtree and batch mutations authorized at the subtree root. */
export async function findByIdsInternal(ids: string[]): Promise<FileRecord[]> {
  return active().findByIdsInternal(ids);
}

/** ⚠️ Authorization bypass: the Drive change feed runs as the sync worker, not as a user. */
export async function findByDriveFileIdInternal(
  googleDriveFileId: string,
): Promise<FileRecord | null> {
  return active().findByDriveFileIdInternal(googleDriveFileId);
}

/** ⚠️ Authorization bypass: a storage de-duplication decision, never a listing. */
export async function findByChecksumInternal(
  organizationId: string,
  checksumSha256: string,
): Promise<FileRecord | null> {
  return active().findByChecksumInternal(organizationId, checksumSha256);
}

/** ⚠️ Authorization bypass: the retention purge runs as no user at all. */
export async function findExpiredTrashInternal(before: Date, limit?: number): Promise<FileRecord[]> {
  return active().findExpiredTrashInternal(before, limit);
}

/* -------------------------------------------------- writes */

export function newId(): string {
  return active().newId();
}

export async function create(input: CreateFileInput, tx?: FileTx): Promise<FileRecord> {
  return active().create(input, tx);
}

export async function updateById(
  id: string,
  patch: FilePatch,
  tx?: FileTx,
): Promise<FileRecord | null> {
  return active().updateById(id, patch, tx);
}

export async function updateByIdWhere(
  id: string,
  guard: FileGuard,
  patch: FilePatch,
  tx?: FileTx,
): Promise<FileRecord | null> {
  return active().updateByIdWhere(id, guard, patch, tx);
}

export async function setDeleted(
  input: { fileId: string; deleted: boolean; userId: string; withFolderId?: string | null },
  tx?: FileTx,
): Promise<void> {
  return active().setDeleted(input, tx);
}

/** ⚠️ Authorization bypass: the Drive change feed acts on nobody's behalf. */
export async function setDeletedBySystem(input: {
  fileId: string;
  deleted: boolean;
}): Promise<boolean> {
  return active().setDeletedBySystem(input);
}

export async function setSubtreeDeleted(
  input: { folderId: string; deleted: boolean; userId: string },
  tx?: FileTx,
): Promise<number> {
  return active().setSubtreeDeleted(input, tx);
}

export async function reparentSubtree(input: ReparentSubtreeInput, tx?: FileTx): Promise<void> {
  return active().reparentSubtree(input, tx);
}

export async function setSubtreeStatus(
  input: { folderId: string; status: 'active' | 'archived' },
  tx?: FileTx,
): Promise<void> {
  return active().setSubtreeStatus(input, tx);
}

export async function unlinkExperiment(experimentId: string, tx?: FileTx): Promise<number> {
  return active().unlinkExperiment(experimentId, tx);
}

/** ⚠️ Authorization bypass: hard delete, reached only by the retention purge and tests. */
export async function purge(fileIds: string[], tx?: FileTx): Promise<number> {
  return active().purge(fileIds, tx);
}

/* -------------------------------------------------- integrity */

export async function checkFileHierarchyIntegrity(
  organizationId: string,
): Promise<FileHierarchyProblem[]> {
  return active().checkFileHierarchyIntegrity(organizationId);
}
