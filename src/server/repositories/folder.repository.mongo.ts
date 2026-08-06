/**
 * Folder persistence, MongoDB.
 *
 * This is the implementation that has been serving production; what changed in Phase 3 module 5
 * is the signature it presents, not the queries it runs. Two of those changes are worth reading
 * before the code:
 *
 *   • reads take an `Actor` and build the visibility filter **here**, rather than accepting one
 *     the service built. Same filters, same results — but a listing can no longer be written
 *     without one.
 *   • `findById` is permission-aware. It previously returned any row and relied on the service
 *     asserting afterwards, which it always did; the filter is a second gate in front of that
 *     one, and `findByIdInternal` is the named door for the callers that legitimately need to
 *     see rows no actor may (see the contract).
 *
 * Subtree operations stay here rather than in the service because they must be single
 * statements: moving a folder with ten thousand descendants by loading and re-saving each one
 * would be both slow and non-atomic. `moveSubtree` and `setSubtreeDeleted` use update pipelines
 * that rewrite `pathAncestors` in place, inside the caller's transaction.
 */
import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import type { PipelineStage } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { FolderModel, type FolderDocument } from '@/server/db/models';
import type { AclEntry, Actor } from '@/server/permissions/actor';
import {
  childVisibilityFilter,
  resourceLookupFilter,
  resourceVisibilityFilter,
} from '@/server/permissions/visibility';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type {
  CreateFolderInput,
  EnsureRootInput,
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

type LeanFolder = FolderDocument & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export function toRecord(doc: LeanFolder): FolderRecord {
  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    name: doc.name,
    parentFolderId: doc.parentFolderId ? String(doc.parentFolderId) : null,
    pathAncestors: (doc.pathAncestors ?? []).map(String),
    depth: doc.depth ?? 0,
    driveType: doc.driveType as FolderRecord['driveType'],
    rootKey: doc.rootKey ?? null,
    ownerId: String(doc.ownerId),
    departmentId: doc.departmentId ? String(doc.departmentId) : null,
    projectId: doc.projectId ? String(doc.projectId) : null,
    permissions: (doc.permissions ?? []).map((entry) => ({
      principalType: entry.principalType as AclEntry['principalType'],
      principalId: String(entry.principalId),
      accessLevel: entry.accessLevel,
      deny: Boolean(entry.deny),
      expiresAt: entry.expiresAt ?? null,
    })),
    inheritPermissions: doc.inheritPermissions !== false,
    confidentiality: doc.confidentiality as ConfidentialityLevel,
    status: doc.status ?? 'active',
    description: doc.description ?? '',
    color: doc.color ?? null,
    templateKey: doc.templateKey ?? null,
    isSystem: Boolean(doc.isSystem),
    childFolderCount: doc.childFolderCount ?? 0,
    fileCount: doc.fileCount ?? 0,
    createdBy: String(doc.createdBy),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    deletedAt: doc.deletedAt ?? null,
    trashedWithFolderId: doc.trashedWithFolderId ? String(doc.trashedWithFolderId) : null,
  };
}

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

/** `Types.ObjectId.isValid` accepts any 12-character string; a folder id is 24-char hex. */
export function isValidId(value: string): boolean {
  return Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value);
}

function session(tx: FolderTx): { session: ClientSession } | Record<string, never> {
  return tx ? { session: tx } : {};
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ reads */

export async function findById(
  actor: Actor,
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<FolderRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const query = FolderModel.findOne({
    $and: [{ _id: oid(id) }, resourceLookupFilter(actor)],
  } as FilterQuery<FolderDocument>);
  if (options.includeDeleted) query.setOptions({ withDeleted: true });
  const doc = await query.lean<LeanFolder>().exec();
  return doc ? toRecord(doc) : null;
}

export async function findByIds(
  actor: Actor,
  ids: string[],
  options: { includeDeleted?: boolean } = {},
): Promise<FolderRecord[]> {
  const valid = ids.filter(isValidId).map(oid);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const query = FolderModel.find({
    $and: [{ _id: { $in: valid } }, resourceLookupFilter(actor)],
  } as FilterQuery<FolderDocument>);
  if (options.includeDeleted) query.setOptions({ withDeleted: true });
  const docs = await query.lean<LeanFolder[]>().exec();
  return docs.map(toRecord);
}

export async function findByIdInternal(
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<FolderRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const query = FolderModel.findOne({ _id: oid(id) });
  if (options.includeDeleted) query.setOptions({ withDeleted: true });
  const doc = await query.lean<LeanFolder>().exec();
  return doc ? toRecord(doc) : null;
}

export async function findByIdsInternal(ids: string[]): Promise<FolderRecord[]> {
  const valid = ids.filter(isValidId).map(oid);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await FolderModel.find({ _id: { $in: valid } })
    .setOptions({ withDeleted: true })
    .lean<LeanFolder[]>()
    .exec();
  return docs.map(toRecord);
}

export async function findByDriveFolderIdInternal(
  googleDriveFolderId: string,
): Promise<FolderRecord | null> {
  if (!googleDriveFolderId) return null;
  await connectToDatabase();
  const doc = await FolderModel.findOne({ googleDriveFolderId })
    .setOptions({ withDeleted: true })
    .lean<LeanFolder>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function findByRootKeyInternal(rootKey: string): Promise<FolderRecord | null> {
  await connectToDatabase();
  const doc = await FolderModel.findOne({ rootKey }).lean<LeanFolder>().exec();
  return doc ? toRecord(doc) : null;
}

/** Folders with these root keys, for the drive-navigation payload. */
export async function findByRootKeysInternal(rootKeys: string[]): Promise<FolderRecord[]> {
  if (rootKeys.length === 0) return [];
  await connectToDatabase();
  const docs = await FolderModel.find({ rootKey: { $in: rootKeys } })
    .lean<LeanFolder[]>()
    .exec();
  return docs.map(toRecord);
}

interface PagedQuery {
  filter: FilterQuery<FolderDocument>;
  page: number;
  pageSize: number;
  sort: Record<string, 1 | -1>;
  includeDeleted?: boolean;
}

/**
 * Rows and `total` from one filter.
 *
 * The count is not optional and not computed from a different filter: a `total` that includes
 * a row the actor cannot see is the same disclosure as returning the row.
 */
async function paged(options: PagedQuery): Promise<FolderPage> {
  await connectToDatabase();
  const query = FolderModel.find(options.filter)
    .sort(options.sort)
    .skip((options.page - 1) * options.pageSize)
    .limit(options.pageSize);
  const countQuery = FolderModel.countDocuments(options.filter);

  if (options.includeDeleted) {
    query.setOptions({ withDeleted: true });
    countQuery.setOptions({ withDeleted: true });
  }

  const [docs, total] = await Promise.all([
    query.lean<LeanFolder[]>().exec(),
    countQuery.exec(),
  ]);
  return { items: docs.map(toRecord), total };
}

/** `_id` breaks ties so pagination is stable when many folders share a timestamp. */
function sortSpec(sort: FolderSortField, order: 'asc' | 'desc'): Record<string, 1 | -1> {
  return { [sort]: order === 'desc' ? -1 : 1, _id: 1 };
}

function childrenFilter(
  input: Omit<ListChildrenInput, 'page' | 'pageSize' | 'sort' | 'order'>,
): FilterQuery<FolderDocument> {
  const conditions: Record<string, unknown>[] = [
    childVisibilityFilter(input.actor),
    { organizationId: oid(input.actor.organizationId) },
    { parentFolderId: oid(input.parentFolderId) },
  ];
  if (!input.includeArchived) conditions.push({ status: { $ne: 'archived' } });
  if (input.searchPrefix) {
    // Anchored prefix only. An unanchored regex here is the classic accidental collection
    // scan (docs/phase-0/12, search rules).
    conditions.push({
      nameLower: { $regex: `^${escapeRegex(input.searchPrefix.toLowerCase())}` },
    });
  }
  return { $and: conditions } as FilterQuery<FolderDocument>;
}

export async function listChildrenOf(input: ListChildrenInput): Promise<FolderPage> {
  if (!isValidId(input.parentFolderId)) return { items: [], total: 0 };
  return paged({
    filter: childrenFilter(input),
    page: input.page,
    pageSize: input.pageSize,
    sort: sortSpec(input.sort, input.order),
  });
}

export async function countChildrenOf(
  input: Omit<ListChildrenInput, 'page' | 'pageSize' | 'sort' | 'order'>,
): Promise<number> {
  if (!isValidId(input.parentFolderId)) return 0;
  await connectToDatabase();
  return FolderModel.countDocuments(childrenFilter(input)).exec();
}

/** Folders the actor deleted themselves — not the descendants swept in with them. */
export async function listTrashed(input: ListForActorInput): Promise<FolderPage> {
  return paged({
    filter: {
      $and: [
        childVisibilityFilter(input.actor),
        {
          organizationId: oid(input.actor.organizationId),
          deletedAt: { $ne: null },
          trashedWithFolderId: null,
        },
      ],
    } as FilterQuery<FolderDocument>,
    page: input.page,
    pageSize: input.pageSize,
    sort: { updatedAt: -1, _id: 1 },
    includeDeleted: true,
  });
}

/** Archived folders the actor may see. Archiving is reversible and keeps the tree intact. */
export async function listArchived(input: ListForActorInput): Promise<FolderPage> {
  return paged({
    filter: {
      $and: [
        childVisibilityFilter(input.actor),
        {
          organizationId: oid(input.actor.organizationId),
          status: 'archived',
          // Only the folder the user archived — its descendants carry the status but no
          // archivedAt, so they do not clutter the list.
          archivedAt: { $ne: null },
        },
      ],
    } as FilterQuery<FolderDocument>,
    page: input.page,
    pageSize: input.pageSize,
    sort: { updatedAt: -1, _id: 1 },
  });
}

/**
 * Folder search, so "where did I put that?" is answerable without remembering the path.
 *
 * Roots are excluded: matching "My Drive" or a department root adds nothing a user did not
 * already have in the sidebar, and they would otherwise dominate every result set.
 *
 * The filter is `resourceVisibilityFilter`, not the broader `resourceLookupFilter` a single-row
 * lookup uses: file search already applies exactly this one, and the two halves of a search
 * response showing different amounts of the drive would be worse than either.
 */
export async function search(input: SearchFoldersInput): Promise<FolderPage> {
  const conditions: Record<string, unknown>[] = [
    resourceVisibilityFilter(input.actor),
    { organizationId: oid(input.actor.organizationId), parentFolderId: { $ne: null } },
  ];

  if (input.text) {
    // Folder names are short, so a substring match on the indexed lower-cased name beats the
    // text index here — a researcher typing "prot" expects "Protocols", which a stemmed word
    // search would not return.
    conditions.push({ nameLower: { $regex: escapeRegex(input.text.toLowerCase()) } });
  }
  if (input.departmentId) conditions.push({ departmentId: oid(input.departmentId) });
  if (input.projectId) conditions.push({ projectId: oid(input.projectId) });
  if (input.underFolderId) conditions.push({ pathAncestors: oid(input.underFolderId) });
  if (!input.includeArchived) conditions.push({ status: { $ne: 'archived' } });

  return paged({
    filter: { $and: conditions } as FilterQuery<FolderDocument>,
    page: input.page,
    pageSize: input.pageSize,
    sort: { nameLower: 1, _id: 1 },
  });
}

/** Folders shared with this actor by an explicit grant. Mirrors the file query exactly. */
export async function listSharedWith(input: ListSharedWithInput): Promise<FolderPage> {
  const principals = input.principalIds.filter(isValidId).map(oid);
  if (principals.length === 0) return { items: [], total: 0 };

  return paged({
    filter: {
      organizationId: oid(input.actor.organizationId),
      ownerId: { $ne: oid(input.actor.userId) },
      status: { $ne: 'archived' },
      permissions: {
        $elemMatch: {
          principalId: { $in: principals },
          deny: { $ne: true },
          $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
        },
      },
    } as FilterQuery<FolderDocument>,
    page: input.page,
    pageSize: input.pageSize,
    sort: { updatedAt: -1, _id: 1 },
  });
}

export async function existsWithName(
  parentFolderId: string,
  nameLower: string,
  excludeId?: string,
): Promise<boolean> {
  if (!isValidId(parentFolderId)) return false;
  await connectToDatabase();
  const filter: FilterQuery<FolderDocument> = {
    parentFolderId: oid(parentFolderId),
    nameLower,
  };
  if (excludeId && isValidId(excludeId)) filter._id = { $ne: oid(excludeId) };
  const count = await FolderModel.countDocuments(filter).exec();
  return count > 0;
}

/**
 * The child of this folder with this name, if there is one.
 *
 * Used by the Drive import to mirror a folder tree idempotently: a re-scan must reuse
 * "06_Raw Data" rather than create "06_Raw Data (2)".
 */
export async function findChildByName(
  parentFolderId: string,
  nameLower: string,
): Promise<FolderRecord | null> {
  if (!isValidId(parentFolderId)) return null;
  await connectToDatabase();
  const doc = await FolderModel.findOne({ parentFolderId: oid(parentFolderId), nameLower })
    .lean<LeanFolder>()
    .exec();
  return doc ? toRecord(doc) : null;
}

/** Lower-cased names already in use inside a folder, for collision-free copy naming. */
export async function takenChildNames(parentFolderId: string): Promise<Set<string>> {
  if (!isValidId(parentFolderId)) return new Set();
  await connectToDatabase();
  const docs = await FolderModel.find({ parentFolderId: oid(parentFolderId) })
    .select({ nameLower: 1 })
    .limit(5000)
    .lean<Array<{ nameLower: string }>>()
    .exec();
  return new Set(docs.map((doc) => doc.nameLower));
}

export async function countDescendants(folderId: string): Promise<number> {
  if (!isValidId(folderId)) return 0;
  await connectToDatabase();
  return FolderModel.countDocuments({ pathAncestors: oid(folderId) }).exec();
}

export async function listDescendantsInternal(
  folderId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<FolderRecord[]> {
  if (!isValidId(folderId)) return [];
  await connectToDatabase();
  const query = FolderModel.find({ pathAncestors: oid(folderId) }).sort({ depth: 1, name: 1 });
  if (options.includeDeleted) query.setOptions({ withDeleted: true });
  const docs = await query.lean<LeanFolder[]>().exec();
  return docs.map(toRecord);
}

/** Folders trashed longer ago than the retention window. Used by the purge job. */
export async function findExpiredTrashInternal(
  before: Date,
  limit = 200,
): Promise<FolderRecord[]> {
  await connectToDatabase();
  const docs = await FolderModel.find({ deletedAt: { $ne: null, $lte: before } })
    .setOptions({ withDeleted: true })
    .limit(limit)
    .lean<LeanFolder[]>()
    .exec();
  return docs.map(toRecord);
}

/* ----------------------------------------------------------------- writes */

export async function create(input: CreateFolderInput, tx?: FolderTx): Promise<FolderRecord> {
  await connectToDatabase();
  const [doc] = await FolderModel.create(
    [
      {
        organizationId: oid(input.organizationId),
        name: input.name,
        nameLower: input.name.toLowerCase(),
        parentFolderId: oid(input.parentFolderId),
        pathAncestors: input.pathAncestors.map(oid),
        depth: input.depth,
        driveType: input.driveType,
        ownerId: oid(input.ownerId),
        departmentId: input.departmentId ? oid(input.departmentId) : null,
        projectId: input.projectId ? oid(input.projectId) : null,
        confidentiality: input.confidentiality,
        description: input.description ?? '',
        color: input.color ?? null,
        templateKey: input.templateKey ?? null,
        createdBy: oid(input.createdBy),
      },
    ],
    tx ? { session: tx } : undefined,
  );
  return toRecord(doc!.toObject() as LeanFolder);
}

/**
 * Race-safe root creation: two simultaneous first requests from the same user must not
 * produce two "My Drive" roots. The unique index on `rootKey` decides the winner and the
 * loser re-reads.
 */
export async function ensureRoot(input: EnsureRootInput): Promise<FolderRecord> {
  await connectToDatabase();
  const existing = await findByRootKeyInternal(input.rootKey);
  if (existing) return existing;

  try {
    const doc = await FolderModel.create({
      organizationId: oid(input.organizationId),
      name: input.name,
      nameLower: input.name.toLowerCase(),
      parentFolderId: null,
      pathAncestors: [],
      depth: 0,
      driveType: input.driveType,
      rootKey: input.rootKey,
      ownerId: oid(input.ownerId),
      departmentId: input.departmentId ? oid(input.departmentId) : null,
      projectId: input.projectId ? oid(input.projectId) : null,
      confidentiality: input.confidentiality,
      isSystem: true,
      createdBy: oid(input.createdBy),
    });
    return toRecord(doc.toObject() as LeanFolder);
  } catch (error) {
    // 11000 = duplicate key: another request created it first.
    if ((error as { code?: number }).code === 11000) {
      const raced = await findByRootKeyInternal(input.rootKey);
      if (raced) return raced;
    }
    throw error;
  }
}

/** `FolderPatch` → `$set` / `$inc`. The only translation MongoDB needs. */
function toUpdate(patch: FolderPatch, now: Date): Record<string, unknown> {
  const set: Record<string, unknown> = {};

  if (patch.name !== undefined) {
    set.name = patch.name;
    set.nameLower = patch.name.toLowerCase();
  }
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.confidentiality !== undefined) set.confidentiality = patch.confidentiality;
  if (patch.inheritPermissions !== undefined) set.inheritPermissions = patch.inheritPermissions;
  if (patch.syncStatus !== undefined) set.syncStatus = patch.syncStatus;
  if (patch.updatedBy !== undefined) {
    set.updatedBy = patch.updatedBy ? oid(patch.updatedBy) : null;
  }
  if (patch.permissions !== undefined) {
    set.permissions = patch.permissions.map((entry) => ({
      principalType: entry.principalType,
      principalId: entry.principalId,
      accessLevel: entry.accessLevel,
      deny: Boolean(entry.deny),
      expiresAt: entry.expiresAt ?? null,
      grantedBy: entry.grantedBy ?? null,
      grantedAt: now,
    }));
  }

  const update: Record<string, unknown> = {};
  if (Object.keys(set).length > 0) update.$set = set;
  if (patch.fileCountDelta !== undefined) update.$inc = { fileCount: patch.fileCountDelta };
  return update;
}

export async function updateById(
  id: string,
  patch: FolderPatch,
  tx?: FolderTx,
): Promise<FolderRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const update = toUpdate(patch, new Date());
  if (Object.keys(update).length === 0) return findByIdInternal(id);

  const query = FolderModel.findOneAndUpdate({ _id: oid(id) }, update, { new: true });
  if (tx) query.session(tx);
  const doc = await query.lean<LeanFolder>().exec();
  return doc ? toRecord(doc) : null;
}

export async function adjustChildFolderCount(
  folderId: string,
  delta: number,
  tx?: FolderTx,
): Promise<void> {
  if (!isValidId(folderId)) return;
  await connectToDatabase();
  const query = FolderModel.updateOne(
    { _id: oid(folderId) },
    { $inc: { childFolderCount: delta } },
  );
  if (tx) query.session(tx);
  await query.exec();
}

/**
 * Re-parents a whole subtree in two statements.
 *
 * The descendants' `pathAncestors` are rewritten by replacing the old prefix (everything up to
 * and including the moved folder) with the new one; `depth` is then recomputed from the array's
 * own size in a second pipeline stage, which sees the value the first stage produced.
 */
export async function moveSubtree(input: MoveSubtreeInput, tx?: FolderTx): Promise<void> {
  await connectToDatabase();
  const folderOid = oid(input.folderId);
  const newAncestors = input.newPathAncestors.map(oid);
  const departmentId = input.departmentId ? oid(input.departmentId) : null;
  const projectId = input.projectId ? oid(input.projectId) : null;

  await FolderModel.updateOne(
    { _id: folderOid },
    {
      $set: {
        parentFolderId: oid(input.newParentId),
        pathAncestors: newAncestors,
        depth: newAncestors.length,
        driveType: input.driveType,
        departmentId,
        projectId,
        ownerId: oid(input.ownerId),
        updatedBy: oid(input.updatedBy),
      },
    },
    session(tx),
  ).exec();

  // Everything below the moved folder keeps its own relative shape.
  const pipeline: PipelineStage.Set[] = [
    {
      $set: {
        pathAncestors: {
          $concatArrays: [
            [...newAncestors, folderOid],
            {
              $slice: [
                '$pathAncestors',
                // Position of the first ancestor *below* the moved folder.
                { $add: [{ $indexOfArray: ['$pathAncestors', folderOid] }, 1] },
                { $size: '$pathAncestors' },
              ],
            },
          ],
        },
        driveType: input.driveType,
        departmentId,
        projectId,
      },
    },
    { $set: { depth: { $size: '$pathAncestors' } } },
  ];

  await FolderModel.updateMany({ pathAncestors: folderOid }, pipeline, session(tx)).exec();
}

/**
 * Trashes or restores a folder together with its subtree.
 *
 * `trashedWithFolderId` records which deletion swept a descendant in, so restoring the parent
 * restores exactly that set — and not folders the user had trashed individually beforehand,
 * which must stay in the trash.
 */
export async function setSubtreeDeleted(
  input: { folderId: string; deleted: boolean; userId: string },
  tx?: FolderTx,
): Promise<number> {
  await connectToDatabase();
  const folderOid = oid(input.folderId);
  const userOid = oid(input.userId);

  if (input.deleted) {
    const now = new Date();
    await FolderModel.updateOne(
      { _id: folderOid },
      {
        $set: {
          deletedAt: now,
          deletedBy: userOid,
          status: 'trashed',
          trashedWithFolderId: null,
        },
      },
      session(tx),
    ).exec();

    // An explicit `deletedAt` in the filter opts out of the soft-delete pre-hook, which is
    // exactly what these statements need: they operate *on* the deleted flag.
    const result = await FolderModel.updateMany(
      { pathAncestors: folderOid, deletedAt: null },
      {
        $set: {
          deletedAt: now,
          deletedBy: userOid,
          status: 'trashed',
          trashedWithFolderId: folderOid,
        },
      },
      session(tx),
    ).exec();
    return result.modifiedCount + 1;
  }

  await FolderModel.updateOne(
    { _id: folderOid, deletedAt: { $ne: null } },
    { $set: { deletedAt: null, deletedBy: null, status: 'active', trashedWithFolderId: null } },
    session(tx),
  ).exec();

  const result = await FolderModel.updateMany(
    { pathAncestors: folderOid, trashedWithFolderId: folderOid, deletedAt: { $ne: null } },
    { $set: { deletedAt: null, deletedBy: null, status: 'active', trashedWithFolderId: null } },
    session(tx),
  ).exec();
  return result.modifiedCount + 1;
}

export async function setSubtreeStatus(
  input: { folderId: string; status: 'active' | 'archived'; userId: string },
  tx?: FolderTx,
): Promise<number> {
  await connectToDatabase();
  const folderOid = oid(input.folderId);
  const archivedAt = input.status === 'archived' ? new Date() : null;

  await FolderModel.updateOne(
    { _id: folderOid },
    { $set: { status: input.status, archivedAt, updatedBy: oid(input.userId) } },
    session(tx),
  ).exec();

  // Descendants change status but keep `archivedAt: null`. That is what marks the one folder
  // the user actually archived, so the Archive view lists it and not its whole subtree.
  const result = await FolderModel.updateMany(
    { pathAncestors: folderOid },
    { $set: { status: input.status } },
    session(tx),
  ).exec();
  return result.modifiedCount + 1;
}

/** Hard delete, used only by the trash-retention purge job and by tests. */
export async function purge(folderIds: string[], tx?: FolderTx): Promise<number> {
  const valid = folderIds.filter(isValidId).map(oid);
  if (valid.length === 0) return 0;
  await connectToDatabase();
  const result = await FolderModel.deleteMany(
    { _id: { $in: valid } },
    tx ? { session: tx } : undefined,
  ).exec();
  return result.deletedCount ?? 0;
}

/* ------------------------------------------------------------------ integrity */

/**
 * The MongoDB half of the hierarchy checker.
 *
 * `pathAncestors` is one array per document rather than a closure table, so three of the five
 * problem kinds are checked differently from D1 and one — "missing ancestor rows" — means "the
 * array is shorter than the parent chain".
 */
export async function checkHierarchyIntegrity(
  organizationId: string,
): Promise<HierarchyProblem[]> {
  await connectToDatabase();
  const docs = await FolderModel.find({ organizationId: oid(organizationId) })
    .setOptions({ withDeleted: true })
    .select({ parentFolderId: 1, pathAncestors: 1, depth: 1, organizationId: 1 })
    .lean<
      Array<{
        _id: Types.ObjectId;
        parentFolderId: Types.ObjectId | null;
        pathAncestors: Types.ObjectId[];
        depth: number;
        organizationId: Types.ObjectId;
      }>
    >()
    .exec();

  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  const problems: HierarchyProblem[] = [];

  for (const doc of docs) {
    const id = String(doc._id);
    const ancestors = (doc.pathAncestors ?? []).map(String);
    const parentId = doc.parentFolderId ? String(doc.parentFolderId) : null;

    if (ancestors.includes(id)) {
      problems.push({ kind: 'cycle', folderId: id, detail: 'the folder is its own ancestor' });
      continue;
    }
    if (doc.depth !== ancestors.length) {
      problems.push({
        kind: 'wrong_depth',
        folderId: id,
        detail: `depth ${doc.depth} but ${ancestors.length} ancestors`,
      });
    }
    if (parentId && ancestors.at(-1) !== parentId) {
      problems.push({
        kind: 'parent_not_in_ancestors',
        folderId: id,
        detail: `parent ${parentId} is not the last ancestor`,
      });
    }
    if (!parentId && ancestors.length > 0) {
      problems.push({
        kind: 'parent_not_in_ancestors',
        folderId: id,
        detail: 'a root carries ancestors',
      });
    }

    for (const ancestorId of ancestors) {
      const ancestor = byId.get(ancestorId);
      if (!ancestor) {
        problems.push({
          kind: 'missing_ancestor_rows',
          folderId: id,
          detail: `ancestor ${ancestorId} does not exist in this organization`,
        });
        continue;
      }
      if (String(ancestor.organizationId) !== organizationId) {
        problems.push({
          kind: 'cross_organization_ancestor',
          folderId: id,
          detail: `ancestor ${ancestorId} belongs to another organization`,
        });
      }
    }
  }

  return problems;
}

export const mongoFolderRepository: FolderRepository = {
  findById,
  findByIds,
  listChildrenOf,
  countChildrenOf,
  listTrashed,
  listArchived,
  search,
  listSharedWith,
  existsWithName,
  findChildByName,
  takenChildNames,
  countDescendants,
  findByIdInternal,
  findByIdsInternal,
  findByDriveFolderIdInternal,
  findByRootKeyInternal,
  findByRootKeysInternal,
  listDescendantsInternal,
  findExpiredTrashInternal,
  create,
  ensureRoot,
  updateById,
  adjustChildFolderCount,
  moveSubtree,
  setSubtreeDeleted,
  setSubtreeStatus,
  purge,
  checkHierarchyIntegrity,
};
