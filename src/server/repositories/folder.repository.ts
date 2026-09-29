/**
 * Folder repository — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_FOLDERS`. MongoDB is the default and stays the default: an unset
 * variable, a typo, and a misspelled module name all resolve to it (`data-source.ts`), so the
 * only way to read folders from D1 is to ask for it by name.
 *
 * **There is no fallback.** If a D1 call fails while the flag is on, the error propagates —
 * it is not retried against MongoDB. A silent fallback would mean the two databases disagreeing
 * about a folder tree with nobody watching, and the first symptom would be a folder that exists
 * in one place and not the other. Rollback is a deliberate act: unset the variable.
 *
 * The dispatch is per call rather than cached at module load, so flipping the variable takes
 * effect on the next request without a restart.
 *
 * Which implementation was selected is logged once per process per value, at info. Enough to
 * answer "which database served this?" from the logs of an incident; not enough to be noise.
 */
import { getLogger } from '@/server/logging/logger';
import { isD1 } from './data-source';
import { mongoFolderRepository } from './folder.repository.mongo';
import { d1FolderRepository } from './folder.repository.d1';
import type {
  AclEntryWrite,
  CreateFolderInput,
  EnsureRootInput,
  FolderDriveMapping,
  FolderPage,
  FolderPatch,
  FolderRecord,
  FolderRepository,
  FolderSortField,
  FolderTx,
  HierarchyProblem,
  ListChildrenInput,
  ListForActorInput,
  ListSharedWithInput,
  MoveSubtreeInput,
  SearchFoldersInput,
} from './folder.repository.contract';
import type { Actor } from '@/server/permissions/actor';

export type {
  AclEntryWrite,
  CreateFolderInput,
  EnsureRootInput,
  FolderDriveMapping,
  FolderPage,
  FolderPatch,
  FolderRecord,
  FolderRepository,
  FolderSortField,
  FolderTx,
  HierarchyProblem,
  ListChildrenInput,
  ListForActorInput,
  ListSharedWithInput,
  MoveSubtreeInput,
  SearchFoldersInput,
};

/** Re-exported so a test can assert the two paths agree without importing both by path. */
export { mongoFolderRepository, d1FolderRepository };

let announced: 'mongo' | 'd1' | null = null;

function active(): FolderRepository {
  const d1 = isD1('folders');
  const selected = d1 ? 'd1' : 'mongo';
  if (announced !== selected) {
    announced = selected;
    getLogger().info({ module: 'folders', dataSource: selected }, 'Folder repository selected');
  }
  return d1 ? d1FolderRepository : mongoFolderRepository;
}

/* -------------------------------------------------- permission-aware reads */

export function findById(
  actor: Actor,
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<FolderRecord | null> {
  return active().findById(actor, id, options);
}

export function findByIds(
  actor: Actor,
  ids: string[],
  options?: { includeDeleted?: boolean },
): Promise<FolderRecord[]> {
  return active().findByIds(actor, ids, options);
}

export function listChildrenOf(input: ListChildrenInput): Promise<FolderPage> {
  return active().listChildrenOf(input);
}

export function countChildrenOf(
  input: Omit<ListChildrenInput, 'page' | 'pageSize' | 'sort' | 'order'>,
): Promise<number> {
  return active().countChildrenOf(input);
}

export function listTrashed(input: ListForActorInput): Promise<FolderPage> {
  return active().listTrashed(input);
}

export function listArchived(input: ListForActorInput): Promise<FolderPage> {
  return active().listArchived(input);
}

export function search(input: SearchFoldersInput): Promise<FolderPage> {
  return active().search(input);
}

export function listSharedWith(input: ListSharedWithInput): Promise<FolderPage> {
  return active().listSharedWith(input);
}

/* -------------------------------------------------- structural reads */

export function existsWithName(
  parentFolderId: string,
  nameLower: string,
  excludeId?: string,
): Promise<boolean> {
  return active().existsWithName(parentFolderId, nameLower, excludeId);
}

export function findChildByName(
  parentFolderId: string,
  nameLower: string,
): Promise<FolderRecord | null> {
  return active().findChildByName(parentFolderId, nameLower);
}

export function takenChildNames(parentFolderId: string): Promise<Set<string>> {
  return active().takenChildNames(parentFolderId);
}

export function countDescendants(folderId: string): Promise<number> {
  return active().countDescendants(folderId);
}

/* -------------------------------------------------- authorization bypasses */

/**
 * ⚠️ Authorization bypass. Trusted server services only — see the contract for the three
 * callers that legitimately need one and why an API route never does.
 */
export function findByIdInternal(
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<FolderRecord | null> {
  return active().findByIdInternal(id, options);
}

/** ⚠️ Authorization bypass: the ancestor chain a permission decision walks must be complete. */
export function findByIdsInternal(ids: string[]): Promise<FolderRecord[]> {
  return active().findByIdsInternal(ids);
}

/** ⚠️ Authorization bypass: the Drive change feed runs as the sync worker, not as a user. */
export function findByDriveFolderIdInternal(
  googleDriveFolderId: string,
): Promise<FolderRecord | null> {
  return active().findByDriveFolderIdInternal(googleDriveFolderId);
}

/**
 * ⚠️ Authorization bypass: folder mirroring runs as the transfer worker, not as a user.
 *
 * Routed like every other read, which is what makes the Drive upload path work on either
 * engine. Reading `FolderModel` directly here — as `folder-mirror.ts` used to — pinned the
 * whole Drive storage backend to MongoDB, and Mongoose cannot run in a Worker.
 */
export function findDriveMappingsInternal(ids: string[]): Promise<FolderDriveMapping[]> {
  return active().findDriveMappingsInternal(ids);
}

/** ⚠️ Authorization bypass: as above. Returns the mapping that is stored afterwards. */
export function recordDriveMappingInternal(input: {
  folderId: string;
  googleDriveFolderId: string;
  googleDriveParentFolderId: string | null;
}): Promise<string> {
  return active().recordDriveMappingInternal(input);
}

/** ⚠️ Authorization bypass: the caller has already authorized the drive itself. */
export function findByRootKeyInternal(rootKey: string): Promise<FolderRecord | null> {
  return active().findByRootKeyInternal(rootKey);
}

/** ⚠️ Authorization bypass: the caller has already authorized each drive it asks about. */
export function findByRootKeysInternal(rootKeys: string[]): Promise<FolderRecord[]> {
  return active().findByRootKeysInternal(rootKeys);
}

/** ⚠️ Authorization bypass: subtree mutations authorized at the root of the subtree. */
export function listDescendantsInternal(
  folderId: string,
  options?: { includeDeleted?: boolean },
): Promise<FolderRecord[]> {
  return active().listDescendantsInternal(folderId, options);
}

/** ⚠️ Authorization bypass: the retention purge runs as no user at all. */
export function findExpiredTrashInternal(before: Date, limit?: number): Promise<FolderRecord[]> {
  return active().findExpiredTrashInternal(before, limit);
}

/* -------------------------------------------------- writes */

export function create(input: CreateFolderInput, tx?: FolderTx): Promise<FolderRecord> {
  return active().create(input, tx);
}

export function ensureRoot(input: EnsureRootInput): Promise<FolderRecord> {
  return active().ensureRoot(input);
}

export function updateById(
  id: string,
  patch: FolderPatch,
  tx?: FolderTx,
): Promise<FolderRecord | null> {
  return active().updateById(id, patch, tx);
}

export function adjustChildFolderCount(
  folderId: string,
  delta: number,
  tx?: FolderTx,
): Promise<void> {
  return active().adjustChildFolderCount(folderId, delta, tx);
}

export function moveSubtree(input: MoveSubtreeInput, tx?: FolderTx): Promise<void> {
  return active().moveSubtree(input, tx);
}

export function setSubtreeDeleted(
  input: { folderId: string; deleted: boolean; userId: string },
  tx?: FolderTx,
): Promise<number> {
  return active().setSubtreeDeleted(input, tx);
}

export function setSubtreeStatus(
  input: { folderId: string; status: 'active' | 'archived'; userId: string },
  tx?: FolderTx,
): Promise<number> {
  return active().setSubtreeStatus(input, tx);
}

export function purge(folderIds: string[], tx?: FolderTx): Promise<number> {
  return active().purge(folderIds, tx);
}

/* -------------------------------------------------- integrity */

export function checkHierarchyIntegrity(organizationId: string): Promise<HierarchyProblem[]> {
  return active().checkHierarchyIntegrity(organizationId);
}
