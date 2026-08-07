/**
 * File repository — a façade over the MongoDB and (eventually) D1 implementations.
 *
 * Routed by `DATA_SOURCE_FILES`. MongoDB is the default and stays the default: an unset
 * variable, a typo, and a misspelled module name all resolve to it (`data-source.ts`), so the
 * only way to read files from anywhere else is to ask for it by name.
 *
 * **There is no fallback.** Asking for D1 today does not quietly serve MongoDB — the D1
 * implementation does not exist yet, so the request fails with a message that says exactly
 * that. A silent fallback would mean an operator believing they were soaking D1 while every
 * read came from MongoDB, and the first symptom would be a migration signed off on evidence
 * that was never collected. The same reasoning applies once the implementation lands: a D1
 * error propagates rather than being retried against MongoDB.
 *
 * The dispatch is per call rather than cached at module load, so flipping the variable takes
 * effect on the next request without a restart.
 *
 * Which implementation was selected is logged once per process per value, at info — enough to
 * answer "which database served this?" from the logs of an incident, not enough to be noise.
 */
import { getLogger } from '@/server/logging/logger';
import { AppError } from '@/server/errors/app-error';
import { isD1 } from './data-source';
import { mongoFileRepository } from './file.repository.mongo';
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
export { mongoFileRepository };

/**
 * Raised when `DATA_SOURCE_FILES=d1` is set before module 6 has landed its implementation.
 *
 * Deliberately a hard failure rather than a warning-and-fallback. The flag exists so an
 * operator can move one module at a time and *observe* the result; serving MongoDB while the
 * logs say "files: d1" would make that observation worthless, and the mistake would only
 * surface much later as a migration verified against the wrong database.
 */
export class D1FileRepositoryUnavailableError extends AppError {
  constructor() {
    super(
      'INTERNAL_ERROR',
      'The file service is not available. Please contact an administrator.',
      500,
      {
        details: {
          reason:
            'DATA_SOURCE_FILES=d1 but the D1 file repository is not implemented yet ' +
            '(Phase 3, module 6). Unset DATA_SOURCE_FILES to use MongoDB.',
        },
      },
    );
  }
}

let announced: 'mongo' | 'd1' | null = null;

function active(): FileRepository {
  const d1 = isD1('files');
  const selected = d1 ? 'd1' : 'mongo';
  if (announced !== selected) {
    announced = selected;
    getLogger().info({ module: 'files', dataSource: selected }, 'File repository selected');
  }
  if (d1) {
    getLogger().error(
      { module: 'files' },
      'DATA_SOURCE_FILES=d1 but the D1 file repository has not been implemented yet',
    );
    throw new D1FileRepositoryUnavailableError();
  }
  return mongoFileRepository;
}

/* -------------------------------------------------- permission-aware reads */

export function findById(
  actor: Actor,
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<FileRecord | null> {
  return active().findById(actor, id, options);
}

export function findByIds(actor: Actor, ids: string[]): Promise<FileRecord[]> {
  return active().findByIds(actor, ids);
}

export function listInFolder(input: ListInFolderInput): Promise<FilePage> {
  return active().listInFolder(input);
}

export function listTrashed(input: ListForActorInput): Promise<FilePage> {
  return active().listTrashed(input);
}

export function search(input: SearchFilesInput): Promise<FilePage> {
  return active().search(input);
}

export function listSharedWith(input: ListSharedWithInput): Promise<FilePage> {
  return active().listSharedWith(input);
}

export function searchFacets(actor: Actor): Promise<SearchFacets> {
  return active().searchFacets(actor);
}

export function findRelated(input: FindRelatedInput): Promise<FileRecord[]> {
  return active().findRelated(input);
}

export function projectContentBreakdown(
  actor: Actor,
  projectId: string,
): Promise<ProjectContentBreakdown> {
  return active().projectContentBreakdown(actor, projectId);
}

/* -------------------------------------------------- structural reads */

export function existsWithName(
  folderId: string,
  displayNameLower: string,
  excludeId?: string,
): Promise<boolean> {
  return active().existsWithName(folderId, displayNameLower, excludeId);
}

export function takenNamesInFolder(folderId: string): Promise<Set<string>> {
  return active().takenNamesInFolder(folderId);
}

export function findByChecksumInFolder(
  folderId: string,
  checksum: string,
): Promise<FileRecord | null> {
  return active().findByChecksumInFolder(folderId, checksum);
}

export function countInFolder(folderId: string): Promise<number> {
  return active().countInFolder(folderId);
}

export function countForExperiment(experimentId: string): Promise<number> {
  return active().countForExperiment(experimentId);
}

/* -------------------------------------------------- authorization bypasses */

/**
 * ⚠️ Authorization bypass. Trusted server services only — see the contract for the callers
 * that legitimately need one and why an API route never does.
 */
export function findByIdInternal(
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<FileRecord | null> {
  return active().findByIdInternal(id, options);
}

/** ⚠️ Authorization bypass: subtree and batch mutations authorized at the subtree root. */
export function findByIdsInternal(ids: string[]): Promise<FileRecord[]> {
  return active().findByIdsInternal(ids);
}

/** ⚠️ Authorization bypass: the Drive change feed runs as the sync worker, not as a user. */
export function findByDriveFileIdInternal(
  googleDriveFileId: string,
): Promise<FileRecord | null> {
  return active().findByDriveFileIdInternal(googleDriveFileId);
}

/** ⚠️ Authorization bypass: a storage de-duplication decision, never a listing. */
export function findByChecksumInternal(
  organizationId: string,
  checksumSha256: string,
): Promise<FileRecord | null> {
  return active().findByChecksumInternal(organizationId, checksumSha256);
}

/** ⚠️ Authorization bypass: the retention purge runs as no user at all. */
export function findExpiredTrashInternal(before: Date, limit?: number): Promise<FileRecord[]> {
  return active().findExpiredTrashInternal(before, limit);
}

/* -------------------------------------------------- writes */

export function newId(): string {
  return active().newId();
}

export function create(input: CreateFileInput, tx?: FileTx): Promise<FileRecord> {
  return active().create(input, tx);
}

export function updateById(
  id: string,
  patch: FilePatch,
  tx?: FileTx,
): Promise<FileRecord | null> {
  return active().updateById(id, patch, tx);
}

export function updateByIdWhere(
  id: string,
  guard: FileGuard,
  patch: FilePatch,
  tx?: FileTx,
): Promise<FileRecord | null> {
  return active().updateByIdWhere(id, guard, patch, tx);
}

export function setDeleted(
  input: { fileId: string; deleted: boolean; userId: string; withFolderId?: string | null },
  tx?: FileTx,
): Promise<void> {
  return active().setDeleted(input, tx);
}

/** ⚠️ Authorization bypass: the Drive change feed acts on nobody's behalf. */
export function setDeletedBySystem(input: {
  fileId: string;
  deleted: boolean;
}): Promise<boolean> {
  return active().setDeletedBySystem(input);
}

export function setSubtreeDeleted(
  input: { folderId: string; deleted: boolean; userId: string },
  tx?: FileTx,
): Promise<number> {
  return active().setSubtreeDeleted(input, tx);
}

export function reparentSubtree(input: ReparentSubtreeInput, tx?: FileTx): Promise<void> {
  return active().reparentSubtree(input, tx);
}

export function setSubtreeStatus(
  input: { folderId: string; status: 'active' | 'archived' },
  tx?: FileTx,
): Promise<void> {
  return active().setSubtreeStatus(input, tx);
}

export function unlinkExperiment(experimentId: string, tx?: FileTx): Promise<number> {
  return active().unlinkExperiment(experimentId, tx);
}

/** ⚠️ Authorization bypass: hard delete, reached only by the retention purge and tests. */
export function purge(fileIds: string[], tx?: FileTx): Promise<number> {
  return active().purge(fileIds, tx);
}

/* -------------------------------------------------- integrity */

export function checkFileHierarchyIntegrity(
  organizationId: string,
): Promise<FileHierarchyProblem[]> {
  return active().checkFileHierarchyIntegrity(organizationId);
}
