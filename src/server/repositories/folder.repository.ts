/**
 * Folder persistence.
 *
 * Subtree operations live here rather than in the service because they must be single
 * statements against the database: moving a folder with ten thousand descendants by
 * loading and re-saving each one would be both slow and non-atomic. `moveSubtree` and
 * `setSubtreeDeleted` therefore use update pipelines that rewrite `pathAncestors` in
 * place, inside the caller's transaction.
 */
import { Types, type ClientSession, type FilterQuery, type PipelineStage } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { FolderModel, type FolderDocument, type DriveType } from '@/server/db/models';
import type { AclEntry } from '@/server/permissions/actor';
import type { ConfidentialityLevel } from '@/server/domain/permissions';

export interface FolderRecord {
  id: string;
  organizationId: string;
  name: string;
  parentFolderId: string | null;
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
    driveType: doc.driveType as DriveType,
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

export function isValidId(value: string): boolean {
  return Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value);
}

/* ------------------------------------------------------------------ reads */

export async function findById(
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

export async function findByIds(ids: string[]): Promise<FolderRecord[]> {
  const valid = ids.filter(isValidId).map(oid);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await FolderModel.find({ _id: { $in: valid } })
    .setOptions({ withDeleted: true })
    .lean<LeanFolder[]>()
    .exec();
  return docs.map(toRecord);
}

/**
 * The application folder a mirrored Drive folder belongs to.
 *
 * Used only by the change feed, which starts from a Drive id and works backwards. Includes
 * trashed folders on purpose: a change arriving for a folder that has since been trashed here
 * still has to be recognised as *ours*, or it would be filed as an unmanaged item and the
 * mirror's disagreement would never be reported.
 */
export async function findByDriveFolderId(
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

export async function findByRootKey(rootKey: string): Promise<FolderRecord | null> {
  await connectToDatabase();
  const doc = await FolderModel.findOne({ rootKey }).lean<LeanFolder>().exec();
  return doc ? toRecord(doc) : null;
}

/**
 * Race-safe root creation: two simultaneous first requests from the same user must not
 * produce two "My Drive" roots. The unique index on `rootKey` decides the winner and
 * the loser re-reads.
 */
export async function ensureRoot(input: {
  rootKey: string;
  organizationId: string;
  name: string;
  driveType: DriveType;
  ownerId: string;
  departmentId?: string | null;
  projectId?: string | null;
  confidentiality: ConfidentialityLevel;
  createdBy: string;
}): Promise<FolderRecord> {
  await connectToDatabase();
  const existing = await findByRootKey(input.rootKey);
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
      const raced = await findByRootKey(input.rootKey);
      if (raced) return raced;
    }
    throw error;
  }
}

export type FolderSortField = 'name' | 'updatedAt' | 'createdAt';

export interface ListChildrenOptions {
  filter: FilterQuery<FolderDocument>;
  page: number;
  pageSize: number;
  sort: FolderSortField;
  order: 'asc' | 'desc';
  includeDeleted?: boolean;
}

export async function listChildren(
  options: ListChildrenOptions,
): Promise<{ items: FolderRecord[]; total: number }> {
  await connectToDatabase();
  const direction = options.order === 'desc' ? -1 : 1;
  // `_id` breaks ties so pagination is stable when many folders share a timestamp.
  const sort: Record<string, 1 | -1> = { [options.sort]: direction, _id: 1 };

  const query = FolderModel.find(options.filter)
    .sort(sort)
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

/**
 * Children of one folder.
 *
 * The visibility fragment comes from the permission layer and is `$and`-ed in here so
 * that no caller can build a listing query without it — the ObjectId conversions stay
 * on this side of the boundary, and services deal in string ids only.
 */
export async function listChildrenOf(input: {
  parentFolderId: string;
  visibility: Record<string, unknown>;
  searchPrefix?: string;
  includeArchived?: boolean;
  page: number;
  pageSize: number;
  sort: FolderSortField;
  order: 'asc' | 'desc';
}): Promise<{ items: FolderRecord[]; total: number }> {
  const conditions: Record<string, unknown>[] = [
    input.visibility,
    { parentFolderId: oid(input.parentFolderId) },
  ];
  if (!input.includeArchived) conditions.push({ status: { $ne: 'archived' } });
  if (input.searchPrefix) {
    // Anchored prefix only. An unanchored regex here is the classic accidental
    // collection scan (docs/phase-0/12, search rules).
    conditions.push({ nameLower: { $regex: `^${escapeRegex(input.searchPrefix.toLowerCase())}` } });
  }

  return listChildren({
    filter: { $and: conditions } as FilterQuery<FolderDocument>,
    page: input.page,
    pageSize: input.pageSize,
    sort: input.sort,
    order: input.order,
  });
}

/** Folders the actor deleted themselves — not the descendants swept in with them. */
export async function listTrashed(input: {
  organizationId: string;
  visibility: Record<string, unknown>;
  page: number;
  pageSize: number;
}): Promise<{ items: FolderRecord[]; total: number }> {
  const filter = {
    $and: [
      input.visibility,
      {
        organizationId: oid(input.organizationId),
        deletedAt: { $ne: null },
        trashedWithFolderId: null,
      },
    ],
  } as FilterQuery<FolderDocument>;

  return listChildren({
    filter,
    page: input.page,
    pageSize: input.pageSize,
    sort: 'updatedAt',
    order: 'desc',
    includeDeleted: true,
  });
}

/** Archived folders the actor may see. Archiving is reversible and keeps the tree intact. */
export async function listArchived(input: {
  organizationId: string;
  visibility: Record<string, unknown>;
  page: number;
  pageSize: number;
}): Promise<{ items: FolderRecord[]; total: number }> {
  const filter = {
    $and: [
      input.visibility,
      {
        organizationId: oid(input.organizationId),
        status: 'archived',
        // Only the folder the user archived — its descendants carry the status but no
        // archivedAt, so they do not clutter the list.
        archivedAt: { $ne: null },
      },
    ],
  } as FilterQuery<FolderDocument>;

  return listChildren({
    filter,
    page: input.page,
    pageSize: input.pageSize,
    sort: 'updatedAt',
    order: 'desc',
  });
}

/** Folders with these root keys, for the drive-navigation payload. */
export async function findByRootKeys(rootKeys: string[]): Promise<FolderRecord[]> {
  if (rootKeys.length === 0) return [];
  await connectToDatabase();
  const docs = await FolderModel.find({ rootKey: { $in: rootKeys } })
    .lean<LeanFolder[]>()
    .exec();
  return docs.map(toRecord);
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function findMany(
  filter: FilterQuery<FolderDocument>,
  options: { limit?: number; includeDeleted?: boolean } = {},
): Promise<FolderRecord[]> {
  await connectToDatabase();
  const query = FolderModel.find(filter).sort({ name: 1 }).limit(options.limit ?? 500);
  if (options.includeDeleted) query.setOptions({ withDeleted: true });
  const docs = await query.lean<LeanFolder[]>().exec();
  return docs.map(toRecord);
}

/**
 * Folder search, so "where did I put that?" is answerable without remembering the path.
 *
 * Roots are excluded: matching "My Drive" or a department root adds nothing a user did
 * not already have in the sidebar, and they would otherwise dominate every result set.
 */
export async function search(input: {
  visibility: Record<string, unknown>;
  organizationId: string;
  text?: string;
  departmentId?: string;
  projectId?: string;
  underFolderId?: string;
  includeArchived?: boolean;
  page: number;
  pageSize: number;
}): Promise<{ items: FolderRecord[]; total: number }> {
  await connectToDatabase();

  const conditions: Record<string, unknown>[] = [
    input.visibility,
    { organizationId: oid(input.organizationId), parentFolderId: { $ne: null } },
  ];

  if (input.text) {
    // Folder names are short, so a prefix/substring match on the indexed lower-cased
    // name beats the text index here — a researcher typing "prot" expects "Protocols",
    // which a stemmed word search would not return.
    conditions.push({ nameLower: { $regex: escapeRegex(input.text.toLowerCase()) } });
  }
  if (input.departmentId) conditions.push({ departmentId: oid(input.departmentId) });
  if (input.projectId) conditions.push({ projectId: oid(input.projectId) });
  if (input.underFolderId) conditions.push({ pathAncestors: oid(input.underFolderId) });
  if (!input.includeArchived) conditions.push({ status: { $ne: 'archived' } });

  const filter = { $and: conditions } as FilterQuery<FolderDocument>;

  const [docs, total] = await Promise.all([
    FolderModel.find(filter)
      .sort({ nameLower: 1, _id: 1 })
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean<LeanFolder[]>()
      .exec(),
    FolderModel.countDocuments(filter).exec(),
  ]);

  return { items: docs.map(toRecord), total };
}

/** Folders shared with this actor by an explicit grant. Mirrors the file query exactly. */
export async function listSharedWith(input: {
  organizationId: string;
  principalIds: string[];
  excludeOwnerId: string;
  page: number;
  pageSize: number;
}): Promise<{ items: FolderRecord[]; total: number }> {
  const principals = input.principalIds.filter(isValidId).map(oid);
  if (principals.length === 0) return { items: [], total: 0 };

  await connectToDatabase();

  const filter = {
    organizationId: oid(input.organizationId),
    ownerId: { $ne: oid(input.excludeOwnerId) },
    status: { $ne: 'archived' },
    permissions: {
      $elemMatch: {
        principalId: { $in: principals },
        deny: { $ne: true },
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      },
    },
  } as FilterQuery<FolderDocument>;

  const [docs, total] = await Promise.all([
    FolderModel.find(filter)
      .sort({ updatedAt: -1, _id: 1 })
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean<LeanFolder[]>()
      .exec(),
    FolderModel.countDocuments(filter).exec(),
  ]);

  return { items: docs.map(toRecord), total };
}

export async function existsWithName(
  parentFolderId: string,
  nameLower: string,
  excludeId?: string,
): Promise<boolean> {
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

export async function countDescendants(folderId: string): Promise<number> {
  if (!isValidId(folderId)) return 0;
  await connectToDatabase();
  return FolderModel.countDocuments({ pathAncestors: oid(folderId) }).exec();
}

export async function listDescendants(
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

/* ----------------------------------------------------------------- writes */

export interface CreateFolderInput {
  organizationId: string;
  name: string;
  parentFolderId: string;
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

export async function create(
  input: CreateFolderInput,
  session?: ClientSession,
): Promise<FolderRecord> {
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
    session ? { session } : undefined,
  );
  return toRecord(doc!.toObject() as LeanFolder);
}

export async function updateById(
  id: string,
  update: Record<string, unknown>,
  session?: ClientSession,
): Promise<FolderRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const query = FolderModel.findOneAndUpdate({ _id: oid(id) }, update, { new: true });
  if (session) query.session(session);
  const doc = await query.lean<LeanFolder>().exec();
  return doc ? toRecord(doc) : null;
}

export async function adjustChildFolderCount(
  folderId: string,
  delta: number,
  session?: ClientSession,
): Promise<void> {
  if (!isValidId(folderId)) return;
  await connectToDatabase();
  const query = FolderModel.updateOne({ _id: oid(folderId) }, { $inc: { childFolderCount: delta } });
  if (session) query.session(session);
  await query.exec();
}

/**
 * Re-parents a whole subtree in two statements.
 *
 * The descendants' `pathAncestors` are rewritten by replacing the old prefix (everything
 * up to and including the moved folder) with the new one; `depth` is then recomputed
 * from the array's own size in a second pipeline stage, which sees the value the first
 * stage produced.
 */
export async function moveSubtree(
  input: {
    folderId: string;
    newParentId: string;
    newPathAncestors: string[];
    driveType: DriveType;
    departmentId: string | null;
    projectId: string | null;
    ownerId: string;
    updatedBy: string;
  },
  session?: ClientSession,
): Promise<void> {
  await connectToDatabase();
  const folderOid = oid(input.folderId);
  const newAncestors = input.newPathAncestors.map(oid);
  const departmentId = input.departmentId ? oid(input.departmentId) : null;
  const projectId = input.projectId ? oid(input.projectId) : null;

  const sessionOption = session ? { session } : {};

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
    sessionOption,
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

  await FolderModel.updateMany({ pathAncestors: folderOid }, pipeline, sessionOption).exec();
}

/**
 * Trashes or restores a folder together with its subtree.
 *
 * `trashedWithFolderId` records which deletion swept a descendant in, so restoring the
 * parent restores exactly that set — and not folders the user had trashed individually
 * beforehand, which must stay in the trash.
 */
export async function setSubtreeDeleted(
  input: { folderId: string; deleted: boolean; userId: string },
  session?: ClientSession,
): Promise<number> {
  await connectToDatabase();
  const folderOid = oid(input.folderId);
  const sessionOption = session ? { session } : {};
  const userOid = oid(input.userId);

  if (input.deleted) {
    const now = new Date();
    await FolderModel.updateOne(
      { _id: folderOid },
      { $set: { deletedAt: now, deletedBy: userOid, status: 'trashed', trashedWithFolderId: null } },
      sessionOption,
    ).exec();

    // An explicit `deletedAt` in the filter opts out of the soft-delete pre-hook, which
    // is exactly what these statements need: they operate *on* the deleted flag.
    const result = await FolderModel.updateMany(
      { pathAncestors: folderOid, deletedAt: null },
      { $set: { deletedAt: now, deletedBy: userOid, status: 'trashed', trashedWithFolderId: folderOid } },
      sessionOption,
    ).exec();
    return result.modifiedCount + 1;
  }

  await FolderModel.updateOne(
    { _id: folderOid, deletedAt: { $ne: null } },
    { $set: { deletedAt: null, deletedBy: null, status: 'active', trashedWithFolderId: null } },
    sessionOption,
  ).exec();

  const result = await FolderModel.updateMany(
    { pathAncestors: folderOid, trashedWithFolderId: folderOid, deletedAt: { $ne: null } },
    { $set: { deletedAt: null, deletedBy: null, status: 'active', trashedWithFolderId: null } },
    sessionOption,
  ).exec();
  return result.modifiedCount + 1;
}

export async function setSubtreeStatus(
  input: { folderId: string; status: 'active' | 'archived'; userId: string },
  session?: ClientSession,
): Promise<number> {
  await connectToDatabase();
  const folderOid = oid(input.folderId);
  const sessionOption = session ? { session } : {};
  const archivedAt = input.status === 'archived' ? new Date() : null;

  await FolderModel.updateOne(
    { _id: folderOid },
    { $set: { status: input.status, archivedAt, updatedBy: oid(input.userId) } },
    sessionOption,
  ).exec();

  // Descendants change status but keep `archivedAt: null`. That is what marks the one
  // folder the user actually archived, so the Archive view lists it and not its whole
  // subtree.
  const result = await FolderModel.updateMany(
    { pathAncestors: folderOid },
    { $set: { status: input.status } },
    sessionOption,
  ).exec();
  return result.modifiedCount + 1;
}

/** Hard delete, used only by the trash-retention purge job and by tests. */
export async function purge(folderIds: string[], session?: ClientSession): Promise<number> {
  const valid = folderIds.filter(isValidId).map(oid);
  if (valid.length === 0) return 0;
  await connectToDatabase();
  const result = await FolderModel.deleteMany(
    { _id: { $in: valid } },
    session ? { session } : undefined,
  ).exec();
  return result.deletedCount ?? 0;
}

/** Folders trashed longer ago than the retention window. Used by the purge job. */
export async function findExpiredTrash(before: Date, limit = 200): Promise<FolderRecord[]> {
  await connectToDatabase();
  const docs = await FolderModel.find({ deletedAt: { $ne: null, $lte: before } })
    .setOptions({ withDeleted: true })
    .limit(limit)
    .lean<LeanFolder[]>()
    .exec();
  return docs.map(toRecord);
}
