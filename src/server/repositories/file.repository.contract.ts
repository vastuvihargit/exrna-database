/**
 * The file repository contract, stated without reference to either database.
 *
 * `FileRecord` is unchanged from the Mongoose version, field for field, so no API response
 * shape changes with the flag.
 *
 * Four things here are not mechanical translations. Each is a MongoDB signature that could not
 * survive the move, and the folder module (`folder.repository.contract.ts`) met the first three
 * in the same form.
 *
 * ── 1. Reads take an `Actor`, not a filter fragment ─────────────────────────────────────
 *
 * `listInFolder({ visibility })` used to take a MongoDB filter object built by the service. A
 * `Record<string, unknown>` means nothing to SQL, so the contract takes the **actor** and each
 * implementation builds its own predicate. The property that mattered is preserved and
 * strengthened: a listing cannot be written without a visibility predicate, because the
 * predicate is derived inside the repository from a required argument rather than passed in by
 * a caller who could forget it.
 *
 * ── 2. `findById` is permission-aware ───────────────────────────────────────────────────
 *
 * The MongoDB `findById(id)` took no actor at all and returned any row in the database; every
 * caller was expected to run `file-access.ts` afterwards, and the security of the endpoint
 * rested on nobody forgetting. The user-facing lookup now applies `lookupVisibility` in SQL, so
 * a guessed id cannot load a row the actor has no route to. `assertCan` still runs afterwards
 * and still makes the actual decision — this is the half that stops the row being read at all.
 *
 * Callers that legitimately need the unfiltered row use the explicit `*Internal` lookups below.
 *
 * ── 3. `updateById` takes a patch, not an update document ───────────────────────────────
 *
 * `$set`, `$inc`, `$unset` and dotted `metadata.<key>` paths are MongoDB operators. `FilePatch`
 * names the fields the application actually writes across its fifteen call sites, and each
 * implementation applies them its own way. Two counters were ever `$inc`-ed — `versionCount`
 * and `downloadCount` — and they are the two `*Delta` fields.
 *
 * ── 4. Research metadata and tags are separate tables in D1 ─────────────────────────────
 *
 * MongoDB kept `metadata` as a sub-document and `tags` as an array on the file. D1 normalises
 * both (`file_metadata`, `resource_tags`) because they are searched and filtered on. The patch
 * therefore distinguishes *setting* a metadata key from *clearing* one, which is what `$set`
 * with a dotted path and `$unset` expressed.
 */
import type { ClientSession } from 'mongoose';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type { FileCategory } from '@/server/domain/file-types';
import type { FileStorageProvider } from '@/server/db/storage-fields';
import type { AclEntry, Actor } from '@/server/permissions/actor';

/* ------------------------------------------------------------------ records */

export interface FileRecord {
  id: string;
  organizationId: string;
  displayName: string;
  originalFilename: string;
  extension: string;
  category: FileCategory;
  folderId: string;
  /** Ordered root → parent folder. `file_folder_ancestors` in D1. */
  folderPathAncestors: string[];
  driveType: 'my' | 'department' | 'project';
  ownerId: string;
  departmentId: string | null;
  projectId: string | null;
  experimentId: string | null;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  versionCount: number;
  sizeBytes: number;
  mimeType: string;
  checksumSha256: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  confidentiality: ConfidentialityLevel;
  reviewStatus: string;
  approvalStatus: string;
  status: string;
  permissions: AclEntry[];
  inheritPermissions: boolean;
  downloadCount: number;
  /**
   * The file's content is a Google Doc, Sheet or Slide rather than uploaded bytes.
   *
   * A category, never an address — the rule that a `File` holds no storage location is
   * unchanged, and the D1 `files` table repeats it. Drive ids live on `file_versions`.
   */
  hasGoogleNativeContent: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  trashedWithFolderId: string | null;
}

/**
 * An engine-specific transaction handle, threaded through unchanged.
 *
 * **MongoDB** — a `ClientSession`, exactly as before.
 *
 * **D1** — there is no interactive transaction, and the handle is not honoured. It is not
 * silently ignored either: every D1 mutation in this contract is internally atomic through
 * `db.batch()`. What a single batch cannot span is two *repositories*, which is why
 * `d1-unit-of-work.ts` exists — see §7 of the module document. A folder move that also
 * reparents files is composed there, as one batch, rather than as two.
 */
export type FileTx = ClientSession | undefined;

/* ------------------------------------------------------------------ writes */

export interface CreateFileInput {
  /** Minted by `newId()` before the row exists, because the storage key contains it. */
  id?: string;
  organizationId: string;
  displayName: string;
  originalFilename: string;
  extension: string;
  category: FileCategory;
  folderId: string;
  /** Ordered root → parent; the caller has it from the destination folder's own chain. */
  folderPathAncestors: string[];
  driveType: 'my' | 'department' | 'project';
  ownerId: string;
  departmentId: string | null;
  projectId: string | null;
  confidentiality: ConfidentialityLevel;
  sizeBytes: number;
  mimeType: string;
  checksumSha256: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /**
   * Overrides the timestamps. Only the Drive import sets these: an archive whose files all
   * claim to have been created on migration day is useless for provenance.
   */
  createdAt?: Date;
  updatedAt?: Date;
  createdBy: string;
}

/** An ACL entry as written, which carries the grantor the record type does not expose. */
export interface AclEntryWrite extends AclEntry {
  grantedBy?: string | null;
}

/**
 * `undefined` leaves a field alone.
 *
 * `displayName` writes the case-folded copy too — the two must never disagree, and leaving
 * that to callers is how they eventually do. `permissions` replaces the whole set, matching
 * the `$set` the sharing service always performed.
 */
export interface FilePatch {
  displayName?: string;
  originalFilename?: string;
  folderId?: string;
  /** Ordered root → parent. Rewrites `file_folder_ancestors` wholesale in D1. */
  folderPathAncestors?: string[];
  driveType?: 'my' | 'department' | 'project';
  ownerId?: string;
  departmentId?: string | null;
  projectId?: string | null;
  experimentId?: string | null;
  confidentiality?: ConfidentialityLevel;
  reviewStatus?: string;
  approvalStatus?: string;
  status?: string;
  currentVersionId?: string | null;
  approvedVersionId?: string | null;
  sizeBytes?: number;
  mimeType?: string;
  checksumSha256?: string | null;
  hasGoogleNativeContent?: boolean;
  storageProvider?: FileStorageProvider;
  inheritPermissions?: boolean;
  permissions?: AclEntryWrite[];
  /** Replaces the whole tag set. */
  tags?: string[];
  /** Upserts these research-metadata keys, leaving the others alone. */
  metadataSet?: Record<string, unknown>;
  /** Clears these keys. `$unset` with a dotted path. */
  metadataUnset?: string[];
  updatedBy?: string | null;
  lastAccessedAt?: Date | null;
  /** The two counters the application ever incremented rather than set. */
  versionCountDelta?: number;
  downloadCountDelta?: number;
}

/**
 * The subset of `FilePatch` a conditional update may guard on.
 *
 * Deliberately narrow: `updateByIdWhere` exists to make "clear the approval, but only if this
 * version still holds it" a no-op rather than a race, and the two call sites guard on exactly
 * these fields. A wider guard surface would invite expressing arbitrary MongoDB filters again.
 */
export interface FileGuard {
  approvedVersionId?: string | null;
  currentVersionId?: string | null;
  reviewStatus?: string;
  approvalStatus?: string;
  status?: string;
  folderId?: string;
}

export interface ReparentSubtreeInput {
  folderId: string;
  /** The moved folder's new chain, ordered root → new parent. */
  newPathAncestorsForFolder: string[];
  driveType: string;
  departmentId: string | null;
  projectId: string | null;
}

/* ------------------------------------------------------------------ reads */

export type FileSortField = 'displayName' | 'updatedAt' | 'createdAt' | 'sizeBytes';

export interface FilePage {
  items: FileRecord[];
  total: number;
}

export interface ListInFolderInput {
  actor: Actor;
  folderId: string;
  /** Anchored prefix match on the case-folded display name. */
  searchPrefix?: string;
  includeArchived?: boolean;
  page: number;
  pageSize: number;
  sort: FileSortField;
  order: 'asc' | 'desc';
}

export interface ListForActorInput {
  actor: Actor;
  page: number;
  pageSize: number;
}

export interface SearchFilesInput {
  actor: Actor;
  /** Free text, already trimmed and length-capped by the schema. */
  text?: string;
  folderId?: string;
  /** Restricts to a folder subtree, including the folder itself. */
  underFolderId?: string;
  departmentId?: string;
  projectId?: string;
  experimentId?: string;
  ownerId?: string;
  category?: string;
  extension?: string;
  confidentiality?: string;
  reviewStatus?: string;
  approvalStatus?: string;
  tags?: string[];
  /** Exact-match metadata filters, keyed by an allow-listed research field. */
  metadata?: Record<string, string>;
  updatedFrom?: Date;
  updatedTo?: Date;
  minSize?: number;
  maxSize?: number;
  includeArchived?: boolean;
  page: number;
  pageSize: number;
  sort: FileSortField | 'relevance';
  order: 'asc' | 'desc';
}

export interface ListSharedWithInput {
  actor: Actor;
  /** The actor's principals, computed once by the sharing service for files and folders. */
  principalIds: string[];
  excludeOwnerId: string;
  page: number;
  pageSize: number;
}

export interface FindRelatedInput {
  actor: Actor;
  excludeFileId: string;
  experimentId?: string | null;
  sampleId?: string | null;
  experimentCode?: string | null;
  checksumSha256?: string | null;
  limit: number;
}

export interface SearchFacets {
  categories: Array<{ value: string; count: number }>;
  tags: Array<{ value: string; count: number }>;
}

export interface ProjectContentBreakdown {
  totalFiles: number;
  totalBytes: number;
  byCategory: Array<{ value: string; count: number; bytes: number }>;
  byDocumentType: Array<{ value: string; count: number; bytes: number }>;
  byReviewStatus: Array<{ value: string; count: number }>;
  linkedToExperiment: number;
}

/* ------------------------------------------------------------------ integrity */

/** One thing wrong with the stored file hierarchy. See `checkFileHierarchyIntegrity`. */
export interface FileHierarchyProblem {
  kind:
    | 'missing_ancestor_rows'
    | 'wrong_depth'
    | 'cross_organization_ancestor'
    | 'folder_not_in_ancestors'
    | 'missing_folder'
    | 'duplicate_drive_id';
  fileId: string;
  detail: string;
}

/* ------------------------------------------------------------------ the contract */

/**
 * Every method the application uses, split into the categories the security review cares about.
 *
 * **Permission-aware** methods take an `Actor` and apply the visibility predicate inside the
 * query — to the rows, to `COUNT(*)` and therefore to `total`, so a file the actor may not see
 * cannot be inferred from a page that is one item short or from a facet count.
 *
 * **`*Internal` methods bypass authorization entirely.** Each says why on its own declaration.
 * They exist because four callers legitimately need rows no actor may see: the Drive change
 * feed (which starts from a Drive id and must recognise files that have since been trashed),
 * the storage de-duplicator (which makes a storage decision and never discloses where the
 * existing copy is), the re-read a mutation performs on a row it has just written, and the
 * retention purge (which runs as no user at all).
 */
export interface FileRepository {
  /* -------------------------------------------------- permission-aware reads */

  findById(
    actor: Actor,
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<FileRecord | null>;
  findByIds(actor: Actor, ids: string[]): Promise<FileRecord[]>;
  listInFolder(input: ListInFolderInput): Promise<FilePage>;
  listTrashed(input: ListForActorInput): Promise<FilePage>;
  search(input: SearchFilesInput): Promise<FilePage>;
  listSharedWith(input: ListSharedWithInput): Promise<FilePage>;
  searchFacets(actor: Actor): Promise<SearchFacets>;
  findRelated(input: FindRelatedInput): Promise<FileRecord[]>;
  projectContentBreakdown(actor: Actor, projectId: string): Promise<ProjectContentBreakdown>;

  /* -------------------------------------------------- structural reads */

  existsWithName(
    folderId: string,
    displayNameLower: string,
    excludeId?: string,
  ): Promise<boolean>;
  takenNamesInFolder(folderId: string): Promise<Set<string>>;
  findByChecksumInFolder(folderId: string, checksum: string): Promise<FileRecord | null>;
  countInFolder(folderId: string): Promise<number>;
  countForExperiment(experimentId: string): Promise<number>;

  /* -------------------------------------------------- authorization bypasses */

  /**
   * The row, whoever is asking.
   *
   * Trusted server code only: the re-read a mutation performs on a file whose permission it has
   * already asserted, and the storage services. Never reachable from an API route — routes go
   * through `file-access.ts`, which calls the permission-aware `findById`.
   */
  findByIdInternal(id: string, options?: { includeDeleted?: boolean }): Promise<FileRecord | null>;

  /** ⚠️ Bypass: subtree and batch mutations, authorized at the root of the subtree. */
  findByIdsInternal(ids: string[]): Promise<FileRecord[]>;

  /**
   * The application file a mirrored Drive file belongs to.
   *
   * Drive ids live on `file_versions`, so this is a join rather than a column read. Used only
   * by the Drive change feed, which starts from a Drive id and works backwards, and runs as the
   * sync worker rather than as a user. Includes trashed files on purpose: a change arriving for
   * a file that has since been trashed here must still be recognised as *ours*, or it is filed
   * as an unmanaged item and the mirror's disagreement is never reported.
   */
  findByDriveFileIdInternal(googleDriveFileId: string): Promise<FileRecord | null>;

  /**
   * Any live file in this organization with exactly these bytes.
   *
   * ⚠️ Bypass, deliberately: this is a *storage* decision, not a listing. The Drive import uses
   * it to avoid storing a third copy of something two people already saved twice. The caller
   * reports "already present" and never discloses where the existing copy is — which is why
   * the unfiltered lookup does not leak anything.
   */
  findByChecksumInternal(organizationId: string, checksumSha256: string): Promise<FileRecord | null>;

  /** ⚠️ Bypass: the retention purge job's cursor. Runs as no user. */
  findExpiredTrashInternal(before: Date, limit?: number): Promise<FileRecord[]>;

  /* -------------------------------------------------- writes */

  /** Mints an id before the row exists, because the storage key contains it. */
  newId(): string;

  create(input: CreateFileInput, tx?: FileTx): Promise<FileRecord>;
  updateById(id: string, patch: FilePatch, tx?: FileTx): Promise<FileRecord | null>;
  /**
   * A conditional update: applies only while the file still matches `guard`.
   *
   * Clearing a file's approval because an older version's content drifted is only correct if
   * that version is still the one holding the approval. Expressing the condition in the
   * statement makes a lost race a no-op rather than a silent overwrite. Returns `null` when
   * nothing matched, which callers read as "somebody else changed it first".
   */
  updateByIdWhere(
    id: string,
    guard: FileGuard,
    patch: FilePatch,
    tx?: FileTx,
  ): Promise<FileRecord | null>;
  setDeleted(
    input: { fileId: string; deleted: boolean; userId: string; withFolderId?: string | null },
    tx?: FileTx,
  ): Promise<void>;
  /**
   * Trashes or restores a file on nobody's behalf.
   *
   * ⚠️ Bypass: the Drive change feed noticed somebody moved the object in Google Drive.
   * `deletedBy` is left null rather than falsely attributed. Returns whether anything changed,
   * so a replayed change is a no-op the caller can see.
   */
  setDeletedBySystem(input: { fileId: string; deleted: boolean }): Promise<boolean>;
  setSubtreeDeleted(
    input: { folderId: string; deleted: boolean; userId: string },
    tx?: FileTx,
  ): Promise<number>;
  /** Keeps files in step with the folder subtree they live in after a move. */
  reparentSubtree(input: ReparentSubtreeInput, tx?: FileTx): Promise<void>;
  setSubtreeStatus(
    input: { folderId: string; status: 'active' | 'archived' },
    tx?: FileTx,
  ): Promise<void>;
  /** Clears the experiment link on every file pointing at an experiment. */
  unlinkExperiment(experimentId: string, tx?: FileTx): Promise<number>;
  /** ⚠️ Bypass: hard delete. Only the retention purge and the tests reach this. */
  purge(fileIds: string[], tx?: FileTx): Promise<number>;

  /* -------------------------------------------------- integrity */

  /**
   * Everything wrong with the stored file hierarchy, or an empty list.
   *
   * Admin/test tooling rather than a request path: `files.folder_id` and
   * `file_folder_ancestors` are two representations of one truth, and a bug in a subtree
   * mutation shows up as a disagreement between them long before a user notices a file in the
   * wrong place.
   */
  checkFileHierarchyIntegrity(organizationId: string): Promise<FileHierarchyProblem[]>;
}
