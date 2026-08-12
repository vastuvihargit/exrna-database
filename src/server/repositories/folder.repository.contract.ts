/**
 * The folder repository contract, stated without reference to either database.
 *
 * `FolderRecord` is unchanged from the Mongoose version, field for field, so no API response
 * shape changes with the flag.
 *
 * Three things about this contract are not mechanical translations, and each is here because
 * the MongoDB signature could not survive the move:
 *
 * ── 1. Reads take an `Actor`, not a filter fragment ─────────────────────────────────────
 *
 * `listChildrenOf({ visibility })` used to take a MongoDB filter object built by the service.
 * A `Record<string, unknown>` means nothing to SQL, so the contract takes the **actor** and
 * each implementation builds its own predicate — `childVisibilityFilter()` on one side,
 * `childVisibility()` on the other. The property that mattered is preserved and strengthened:
 * a listing cannot be written without a visibility predicate, because the predicate is derived
 * inside the repository from a required argument rather than passed in by a caller who could
 * forget it.
 *
 * ── 2. `updateById` takes a patch, not an update document ───────────────────────────────
 *
 * `{ $set: {...} }` and `{ $inc: {...} }` are MongoDB operators. `FolderPatch` names the
 * fields the application actually writes — there are eight — and each implementation applies
 * them its own way. `fileCountDelta` is the one counter that was ever `$inc`-ed.
 *
 * ── 3. Mutations take an opaque transaction handle ──────────────────────────────────────
 *
 * See `FolderTx`.
 */
import type { ClientSession } from 'mongoose';
import type { DriveType } from '@/server/db/models';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type { SyncStatus } from '@/server/db/storage-fields';
import type { AclEntry, Actor } from '@/server/permissions/actor';

/* ------------------------------------------------------------------ records */

export interface FolderRecord {
  id: string;
  organizationId: string;
  name: string;
  parentFolderId: string | null;
  /** Ordered root → parent. `folder_ancestors` in D1, `pathAncestors[]` in MongoDB. */
  pathAncestors: string[];
  depth: number;
  driveType: DriveType;
  rootKey: string | null;
  ownerId: string;
  departmentId: string | null;
  projectId: string | null;
  permissions: AclEntry[];
  inheritPermissions: boolean;
  confidentiality: ConfidentialityLevel;
  status: string;
  description: string;
  color: string | null;
  templateKey: string | null;
  isSystem: boolean;
  childFolderCount: number;
  fileCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  trashedWithFolderId: string | null;
}

/**
 * What folder mirroring needs, and nothing else.
 *
 * `pathAncestors` is ordered root → parent, so `[...pathAncestors, id]` is the chain to walk.
 */
export interface FolderDriveMapping {
  id: string;
  name: string;
  depth: number;
  pathAncestors: string[];
  googleDriveFolderId: string | null;
}

/**
 * An engine-specific transaction handle, threaded through unchanged.
 *
 * **MongoDB** — a `ClientSession`, exactly as before. `folder.service.ts` still opens a
 * transaction around a folder mutation and the matching file-table mutation, and that
 * atomicity is untouched while `files` is on MongoDB.
 *
 * **D1** — there is no interactive transaction (`db.ts` explains why at length), and the
 * handle is therefore **not honoured**. It is not silently ignored either: every D1 mutation
 * in this contract is internally atomic through `db.batch()`, so the folder half of the work
 * either lands completely or not at all, which is the guarantee the session was providing for
 * *these* statements.
 *
 * What cannot be reproduced while the two modules are on different engines is atomicity
 * **across** them — a folder move writes `folders` in D1 and `files` in MongoDB, and no
 * transaction spans both. That is a property of the mixed window rather than of this
 * contract, it is recorded in the module's rollback notes, and it closes when the file
 * repository moves in the next phase.
 */
export type FolderTx = ClientSession | undefined;

/* ------------------------------------------------------------------ writes */

export interface CreateFolderInput {
  organizationId: string;
  name: string;
  parentFolderId: string;
  /** Ordered root → parent; the caller has it from the parent's own chain. */
  pathAncestors: string[];
  depth: number;
  driveType: DriveType;
  ownerId: string;
  departmentId: string | null;
  projectId: string | null;
  confidentiality: ConfidentialityLevel;
  description?: string;
  color?: string | null;
  templateKey?: string | null;
  createdBy: string;
}

export interface EnsureRootInput {
  rootKey: string;
  organizationId: string;
  name: string;
  driveType: DriveType;
  ownerId: string;
  departmentId?: string | null;
  projectId?: string | null;
  confidentiality: ConfidentialityLevel;
  createdBy: string;
}

/** An ACL entry as written, which carries the grantor the record type does not expose. */
export interface AclEntryWrite extends AclEntry {
  grantedBy?: string | null;
}

/**
 * `undefined` leaves a field alone.
 *
 * `name` writes the case-folded copy too — the two must never disagree, and leaving that to
 * callers is how they eventually do. `permissions` replaces the whole set, matching the
 * `$set` the sharing service always performed.
 */
export interface FolderPatch {
  name?: string;
  description?: string;
  color?: string | null;
  confidentiality?: ConfidentialityLevel;
  inheritPermissions?: boolean;
  permissions?: AclEntryWrite[];
  syncStatus?: SyncStatus;
  updatedBy?: string | null;
  /** The only counter the application ever incremented rather than set. */
  fileCountDelta?: number;
}

export interface MoveSubtreeInput {
  folderId: string;
  newParentId: string;
  /** The destination's own chain plus the destination — ordered root → new parent. */
  newPathAncestors: string[];
  driveType: DriveType;
  departmentId: string | null;
  projectId: string | null;
  ownerId: string;
  updatedBy: string;
}

/* ------------------------------------------------------------------ reads */

export type FolderSortField = 'name' | 'updatedAt' | 'createdAt';

export interface FolderPage {
  items: FolderRecord[];
  total: number;
}

export interface ListChildrenInput {
  actor: Actor;
  parentFolderId: string;
  /** Anchored prefix match on the case-folded name. */
  searchPrefix?: string;
  includeArchived?: boolean;
  page: number;
  pageSize: number;
  sort: FolderSortField;
  order: 'asc' | 'desc';
}

export interface ListForActorInput {
  actor: Actor;
  page: number;
  pageSize: number;
}

export interface SearchFoldersInput {
  actor: Actor;
  text?: string;
  departmentId?: string;
  projectId?: string;
  underFolderId?: string;
  includeArchived?: boolean;
  page: number;
  pageSize: number;
}

export interface ListSharedWithInput {
  actor: Actor;
  /** The actor's principals, computed once by the sharing service for files and folders. */
  principalIds: string[];
  page: number;
  pageSize: number;
}

/* ------------------------------------------------------------------ integrity */

/** One thing wrong with the stored hierarchy. See `checkHierarchyIntegrity`. */
export interface HierarchyProblem {
  kind:
    | 'missing_ancestor_rows'
    | 'wrong_depth'
    | 'cycle'
    | 'cross_organization_ancestor'
    | 'parent_not_in_ancestors';
  folderId: string;
  detail: string;
}

/* ------------------------------------------------------------------ the contract */

/**
 * Every method the application uses, split into the two categories the security review cares
 * about.
 *
 * **Permission-aware** methods take an `Actor` first and apply the visibility predicate inside
 * the query — to the rows, to `COUNT(*)` and therefore to `total`, so a folder the actor may
 * not see cannot be inferred from a page that is one item short.
 *
 * **`*Internal` methods bypass authorization entirely.** Each one says why on its own
 * declaration. They exist because three callers legitimately need to see rows no actor may:
 * the Drive change feed (which starts from a Drive id and must recognise folders that have
 * since been trashed), the ancestor-chain load (which must be *complete* or an inherited deny
 * would go unseen — a truncated chain is a permission bug, not a smaller result), and the
 * retention purge (which runs as no user at all).
 */
export interface FolderRepository {
  /* -------------------------------------------------- permission-aware reads */

  findById(
    actor: Actor,
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<FolderRecord | null>;
  findByIds(
    actor: Actor,
    ids: string[],
    options?: { includeDeleted?: boolean },
  ): Promise<FolderRecord[]>;
  listChildrenOf(input: ListChildrenInput): Promise<FolderPage>;
  countChildrenOf(input: Omit<ListChildrenInput, 'page' | 'pageSize' | 'sort' | 'order'>): Promise<number>;
  listTrashed(input: ListForActorInput): Promise<FolderPage>;
  listArchived(input: ListForActorInput): Promise<FolderPage>;
  search(input: SearchFoldersInput): Promise<FolderPage>;
  listSharedWith(input: ListSharedWithInput): Promise<FolderPage>;

  /* -------------------------------------------------- structural reads */

  existsWithName(parentFolderId: string, nameLower: string, excludeId?: string): Promise<boolean>;
  findChildByName(parentFolderId: string, nameLower: string): Promise<FolderRecord | null>;
  takenChildNames(parentFolderId: string): Promise<Set<string>>;
  countDescendants(folderId: string): Promise<number>;

  /* -------------------------------------------------- authorization bypasses */

  /**
   * The row, whoever is asking.
   *
   * Trusted server code only: the Drive import and mirror, the template builder, and the
   * re-read a mutation performs on a folder whose permission it has already asserted. Never
   * reachable from an API route — routes go through `folder-access.ts`, which calls the
   * permission-aware `findById`.
   */
  findByIdInternal(id: string, options?: { includeDeleted?: boolean }): Promise<FolderRecord | null>;

  /**
   * The ancestor chain, unfiltered — and it has to be.
   *
   * `canAccess` walks this chain looking for an inherited **deny**. Filtering it by what the
   * actor may see would drop exactly the ancestors carrying a denial they are not otherwise
   * allowed to know about, and the walk would then allow what it should refuse. A permission
   * check reads the whole chain or it is not a permission check.
   */
  findByIdsInternal(ids: string[]): Promise<FolderRecord[]>;

  /**
   * The application folder a mirrored Drive folder belongs to.
   *
   * Used only by the Drive change feed, which starts from a Drive id and works backwards, and
   * runs as the sync worker rather than as a user. Includes trashed folders on purpose: a
   * change arriving for a folder that has since been trashed here must still be recognised as
   * *ours*, or it is filed as an unmanaged item and the mirror's disagreement is never
   * reported.
   */
  findByDriveFolderIdInternal(googleDriveFolderId: string): Promise<FolderRecord | null>;

  /**
   * The Drive-mirroring view of a set of folders: name, depth and current mapping.
   *
   * A separate shape rather than fields on `FolderRecord`, for the reason stated at the top of
   * the file-version contract: `googleDriveFolderId` identifies *where a mirror is*, and adding
   * it to the record every listing returns would put storage-side identifiers into API
   * responses that have no business carrying them.
   *
   * Trashed folders are included. A version being transferred may live under a folder that has
   * since been trashed, and refusing to mirror it would strand the transfer.
   */
  findDriveMappingsInternal(ids: string[]): Promise<FolderDriveMapping[]>;

  /**
   * Records the Drive folder one application folder maps to.
   *
   * Returns the id that is **actually stored afterwards**, which is not always the one passed
   * in: two workers mirroring the same folder can each create one, and the loser must adopt
   * the winner's rather than scatter one folder's contents across two. Implementations that
   * cannot detect the race re-read and return what they find.
   */
  recordDriveMappingInternal(input: {
    folderId: string;
    googleDriveFolderId: string;
    googleDriveParentFolderId: string | null;
  }): Promise<string>;

  /** Drive roots, by key. The caller has already authorized the drive itself. */
  findByRootKeyInternal(rootKey: string): Promise<FolderRecord | null>;
  findByRootKeysInternal(rootKeys: string[]): Promise<FolderRecord[]>;

  /**
   * Every folder beneath this one. Unfiltered because its callers are subtree *mutations*
   * (move, copy, depth checks) whose permission was asserted on the root of the subtree.
   */
  listDescendantsInternal(
    folderId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<FolderRecord[]>;

  /** The retention purge job's cursor. Runs as no user. */
  findExpiredTrashInternal(before: Date, limit?: number): Promise<FolderRecord[]>;

  /* -------------------------------------------------- writes */

  create(input: CreateFolderInput, tx?: FolderTx): Promise<FolderRecord>;
  ensureRoot(input: EnsureRootInput): Promise<FolderRecord>;
  updateById(id: string, patch: FolderPatch, tx?: FolderTx): Promise<FolderRecord | null>;
  adjustChildFolderCount(folderId: string, delta: number, tx?: FolderTx): Promise<void>;
  moveSubtree(input: MoveSubtreeInput, tx?: FolderTx): Promise<void>;
  setSubtreeDeleted(
    input: { folderId: string; deleted: boolean; userId: string },
    tx?: FolderTx,
  ): Promise<number>;
  setSubtreeStatus(
    input: { folderId: string; status: 'active' | 'archived'; userId: string },
    tx?: FolderTx,
  ): Promise<number>;
  /** Hard delete. Only the retention purge and the tests reach this. */
  purge(folderIds: string[], tx?: FolderTx): Promise<number>;

  /* -------------------------------------------------- integrity */

  /**
   * Everything wrong with the stored hierarchy, or an empty list.
   *
   * Admin/test tooling rather than a request path: the closure table and the parent pointer
   * are two representations of one truth, and a bug in a subtree mutation shows up as a
   * disagreement between them long before a user notices a folder in the wrong place.
   */
  checkHierarchyIntegrity(organizationId: string): Promise<HierarchyProblem[]>;
}
