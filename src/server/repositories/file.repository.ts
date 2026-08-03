/**
 * File metadata persistence.
 *
 * Nothing in `FileRecord` is physical: no storage key, no path. A caller that needs the
 * bytes goes through the version repository, which is only reachable from the download
 * and preview services.
 */
import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { FileModel, type FileDocument } from '@/server/db/models';
import type { AclEntry } from '@/server/permissions/actor';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type { FileCategory } from '@/server/domain/file-types';

export interface FileRecord {
  id: string;
  organizationId: string;
  displayName: string;
  originalFilename: string;
  extension: string;
  category: FileCategory;
  folderId: string;
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
   * A category, never an address — the rule that a `File` document holds no storage location
   * is unchanged. This is what the interface uses to offer "Open in Google" instead of a
   * preview, and to show a recognizable document icon.
   */
  hasGoogleNativeContent: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  trashedWithFolderId: string | null;
}

type LeanFile = FileDocument & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export function isValidId(value: string): boolean {
  return Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value);
}

export function toRecord(doc: LeanFile): FileRecord {
  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    displayName: doc.displayName,
    originalFilename: doc.originalFilename,
    extension: doc.extension,
    category: doc.category as FileCategory,
    folderId: String(doc.folderId),
    folderPathAncestors: (doc.folderPathAncestors ?? []).map(String),
    driveType: doc.driveType as FileRecord['driveType'],
    ownerId: String(doc.ownerId),
    departmentId: doc.departmentId ? String(doc.departmentId) : null,
    projectId: doc.projectId ? String(doc.projectId) : null,
    experimentId: doc.experimentId ? String(doc.experimentId) : null,
    currentVersionId: doc.currentVersionId ? String(doc.currentVersionId) : null,
    approvedVersionId: doc.approvedVersionId ? String(doc.approvedVersionId) : null,
    versionCount: doc.versionCount ?? 0,
    sizeBytes: doc.sizeBytes ?? 0,
    mimeType: doc.mimeType ?? 'application/octet-stream',
    checksumSha256: doc.checksumSha256 ?? null,
    tags: doc.tags ?? [],
    metadata: (doc.metadata as Record<string, unknown>) ?? {},
    confidentiality: doc.confidentiality as ConfidentialityLevel,
    reviewStatus: doc.reviewStatus ?? 'draft',
    approvalStatus: doc.approvalStatus ?? 'none',
    status: doc.status ?? 'active',
    permissions: (doc.permissions ?? []).map((entry) => ({
      principalType: entry.principalType as AclEntry['principalType'],
      principalId: String(entry.principalId),
      accessLevel: entry.accessLevel,
      deny: Boolean(entry.deny),
      expiresAt: entry.expiresAt ?? null,
    })),
    inheritPermissions: doc.inheritPermissions !== false,
    downloadCount: doc.downloadCount ?? 0,
    hasGoogleNativeContent: doc.hasGoogleNativeContent === true,
    createdBy: String(doc.createdBy),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    deletedAt: doc.deletedAt ?? null,
    trashedWithFolderId: doc.trashedWithFolderId ? String(doc.trashedWithFolderId) : null,
  };
}

/* ------------------------------------------------------------------ reads */

export async function findById(
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<FileRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const query = FileModel.findOne({ _id: oid(id) });
  if (options.includeDeleted) query.setOptions({ withDeleted: true });
  const doc = await query.lean<LeanFile>().exec();
  return doc ? toRecord(doc) : null;
}

export async function findByIds(ids: string[]): Promise<FileRecord[]> {
  const valid = ids.filter(isValidId).map(oid);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await FileModel.find({ _id: { $in: valid } }).lean<LeanFile[]>().exec();
  return docs.map(toRecord);
}

export type FileSortField = 'displayName' | 'updatedAt' | 'createdAt' | 'sizeBytes';

export async function listInFolder(input: {
  folderId: string;
  visibility: Record<string, unknown>;
  searchPrefix?: string;
  includeArchived?: boolean;
  page: number;
  pageSize: number;
  sort: FileSortField;
  order: 'asc' | 'desc';
}): Promise<{ items: FileRecord[]; total: number }> {
  await connectToDatabase();

  const conditions: Record<string, unknown>[] = [
    input.visibility,
    { folderId: oid(input.folderId) },
  ];
  if (!input.includeArchived) conditions.push({ status: { $ne: 'archived' } });
  if (input.searchPrefix) {
    conditions.push({
      displayNameLower: { $regex: `^${escapeRegex(input.searchPrefix.toLowerCase())}` },
    });
  }

  const filter = { $and: conditions } as FilterQuery<FileDocument>;
  const direction = input.order === 'desc' ? -1 : 1;
  const sortField = input.sort === 'displayName' ? 'displayNameLower' : input.sort;

  const [docs, total] = await Promise.all([
    FileModel.find(filter)
      .sort({ [sortField]: direction, _id: 1 })
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean<LeanFile[]>()
      .exec(),
    FileModel.countDocuments(filter).exec(),
  ]);

  return { items: docs.map(toRecord), total };
}

export async function listTrashed(input: {
  organizationId: string;
  visibility: Record<string, unknown>;
  page: number;
  pageSize: number;
}): Promise<{ items: FileRecord[]; total: number }> {
  await connectToDatabase();
  const filter = {
    $and: [
      input.visibility,
      {
        organizationId: oid(input.organizationId),
        deletedAt: { $ne: null },
        trashedWithFolderId: null,
      },
    ],
  } as FilterQuery<FileDocument>;

  const [docs, total] = await Promise.all([
    FileModel.find(filter)
      .setOptions({ withDeleted: true })
      .sort({ updatedAt: -1 })
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean<LeanFile[]>()
      .exec(),
    FileModel.countDocuments(filter).setOptions({ withDeleted: true }).exec(),
  ]);

  return { items: docs.map(toRecord), total };
}

/**
 * Cross-drive search.
 *
 * The visibility filter is a required argument rather than an option, so a search query
 * cannot be written that forgets it — the leak this endpoint exists to avoid is a
 * restricted filename appearing in someone else's results, and `total` counting a row
 * the viewer cannot open is the same leak in numeric form.
 *
 * With a text term the sort is by relevance and the projection carries `textScore`;
 * without one it is an ordinary indexed filter query, which is what makes
 * "everything in this project tagged `qpcr`" fast without a search term at all.
 */
export interface SearchFilesInput {
  visibility: Record<string, unknown>;
  organizationId: string;
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

export async function search(
  input: SearchFilesInput,
): Promise<{ items: FileRecord[]; total: number }> {
  await connectToDatabase();

  const conditions: Record<string, unknown>[] = [
    input.visibility,
    { organizationId: oid(input.organizationId) },
  ];

  if (input.text) conditions.push({ $text: { $search: input.text } });
  if (input.folderId) conditions.push({ folderId: oid(input.folderId) });
  if (input.underFolderId) {
    const under = oid(input.underFolderId);
    conditions.push({ $or: [{ folderId: under }, { folderPathAncestors: under }] });
  }
  if (input.departmentId) conditions.push({ departmentId: oid(input.departmentId) });
  if (input.projectId) conditions.push({ projectId: oid(input.projectId) });
  if (input.experimentId) conditions.push({ experimentId: oid(input.experimentId) });
  if (input.ownerId) conditions.push({ ownerId: oid(input.ownerId) });
  if (input.category) conditions.push({ category: input.category });
  if (input.extension) conditions.push({ extension: input.extension.toLowerCase() });
  if (input.confidentiality) conditions.push({ confidentiality: input.confidentiality });
  if (input.reviewStatus) conditions.push({ reviewStatus: input.reviewStatus });
  if (input.approvalStatus) conditions.push({ approvalStatus: input.approvalStatus });
  if (input.tags?.length) conditions.push({ tags: { $all: input.tags } });

  // Keys come from the research-metadata allow-list, so no caller-controlled string ever
  // reaches a dotted path here.
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    conditions.push({ [`metadata.${key}`]: value });
  }

  if (input.updatedFrom || input.updatedTo) {
    conditions.push({
      updatedAt: {
        ...(input.updatedFrom ? { $gte: input.updatedFrom } : {}),
        ...(input.updatedTo ? { $lte: input.updatedTo } : {}),
      },
    });
  }
  if (input.minSize !== undefined || input.maxSize !== undefined) {
    conditions.push({
      sizeBytes: {
        ...(input.minSize !== undefined ? { $gte: input.minSize } : {}),
        ...(input.maxSize !== undefined ? { $lte: input.maxSize } : {}),
      },
    });
  }
  if (!input.includeArchived) conditions.push({ status: { $ne: 'archived' } });

  const filter = { $and: conditions } as FilterQuery<FileDocument>;
  const direction = input.order === 'desc' ? -1 : 1;

  // Relevance is only meaningful with a text term; without one it degrades to the most
  // recently touched, which is the useful answer for a pure filter query.
  const useRelevance = input.sort === 'relevance' && Boolean(input.text);
  const sortSpec: Record<string, unknown> = useRelevance
    ? { score: { $meta: 'textScore' }, updatedAt: -1 }
    : input.sort === 'relevance'
      ? { updatedAt: -1, _id: 1 }
      : { [input.sort === 'displayName' ? 'displayNameLower' : input.sort]: direction, _id: 1 };

  const query = FileModel.find(filter);
  if (useRelevance) query.select({ score: { $meta: 'textScore' } });

  const [docs, total] = await Promise.all([
    query
      .sort(sortSpec as never)
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean<LeanFile[]>()
      .exec(),
    FileModel.countDocuments(filter).exec(),
  ]);

  return { items: docs.map(toRecord), total };
}

/**
 * Files reachable through an explicit grant to this actor.
 *
 * Not "everything visible": role scope already gives a department head their whole
 * department, and listing that here would drown the one file a colleague actually handed
 * over. `excludeOwnerId` drops the actor's own files for the same reason.
 *
 * Denies are excluded in the query rather than filtered afterwards — an entry that says
 * "you may not open this" is not a share, and surfacing it would announce the existence
 * of something the actor was specifically blocked from.
 */
export async function listSharedWith(input: {
  organizationId: string;
  principalIds: string[];
  excludeOwnerId: string;
  page: number;
  pageSize: number;
}): Promise<{ items: FileRecord[]; total: number }> {
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
  } as FilterQuery<FileDocument>;

  const [docs, total] = await Promise.all([
    FileModel.find(filter)
      .sort({ updatedAt: -1, _id: 1 })
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean<LeanFile[]>()
      .exec(),
    FileModel.countDocuments(filter).exec(),
  ]);

  return { items: docs.map(toRecord), total };
}

/** Distinct values for the facet chips shown beside search results. */
export async function searchFacets(
  visibility: Record<string, unknown>,
  organizationId: string,
): Promise<{ categories: Array<{ value: string; count: number }>; tags: Array<{ value: string; count: number }> }> {
  await connectToDatabase();
  const match = { $and: [visibility, { organizationId: oid(organizationId) }] };

  const [categories, tags] = await Promise.all([
    FileModel.aggregate<{ _id: string; count: number }>([
      { $match: match },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]).exec(),
    FileModel.aggregate<{ _id: string; count: number }>([
      { $match: match },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 30 },
    ]).exec(),
  ]);

  return {
    categories: categories.map((row) => ({ value: row._id, count: row.count })),
    tags: tags.map((row) => ({ value: row._id, count: row.count })),
  };
}

/**
 * Files related to one file, in a single indexed query.
 *
 * "Related" is four different questions the platform is asked constantly, and answering
 * them separately would mean four round trips and four permission passes:
 *
 *   • same experiment      — what else came out of this run
 *   • same sample id       — everything ever recorded about this tube
 *   • same experiment code — the annotation equivalent, for files not formally linked
 *   • same checksum        — *the same bytes, filed somewhere else*, which is the
 *                            duplicate problem the brief opens with
 *
 * The visibility filter is required, exactly as in `search`: a related-files panel that
 * revealed a duplicate sitting in a folder the viewer cannot open would leak both the
 * filename and the fact that the content is stored twice.
 */
export async function findRelated(input: {
  visibility: Record<string, unknown>;
  organizationId: string;
  excludeFileId: string;
  experimentId?: string | null;
  sampleId?: string | null;
  experimentCode?: string | null;
  checksumSha256?: string | null;
  limit: number;
}): Promise<FileRecord[]> {
  await connectToDatabase();

  const branches: Record<string, unknown>[] = [];
  if (input.experimentId) branches.push({ experimentId: oid(input.experimentId) });
  if (input.sampleId) branches.push({ 'metadata.sampleId': input.sampleId });
  if (input.experimentCode) branches.push({ 'metadata.experimentCode': input.experimentCode });
  if (input.checksumSha256) branches.push({ checksumSha256: input.checksumSha256 });
  if (branches.length === 0) return [];

  const filter = {
    $and: [
      input.visibility,
      { organizationId: oid(input.organizationId) },
      { _id: { $ne: oid(input.excludeFileId) } },
      { $or: branches },
    ],
  } as FilterQuery<FileDocument>;

  const docs = await FileModel.find(filter)
    .sort({ updatedAt: -1 })
    .limit(input.limit)
    .lean<LeanFile[]>()
    .exec();
  return docs.map(toRecord);
}

/**
 * Any live file in this organization with exactly these bytes.
 *
 * Used by the Drive import to avoid storing a third copy of a file that two people had
 * already saved twice. Deliberately *not* visibility-filtered: this is a storage
 * decision, not a listing — the caller reports "already present" and never discloses
 * where the existing copy is.
 */
export async function findByChecksum(
  organizationId: string,
  checksumSha256: string,
): Promise<FileRecord | null> {
  if (!checksumSha256) return null;
  await connectToDatabase();
  const doc = await FileModel.findOne({
    organizationId: oid(organizationId),
    checksumSha256,
  })
    .lean<LeanFile>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function countForExperiment(experimentId: string): Promise<number> {
  if (!isValidId(experimentId)) return 0;
  await connectToDatabase();
  return FileModel.countDocuments({ experimentId: oid(experimentId) }).exec();
}

export interface ProjectContentBreakdown {
  totalFiles: number;
  totalBytes: number;
  byCategory: Array<{ value: string; count: number; bytes: number }>;
  byDocumentType: Array<{ value: string; count: number; bytes: number }>;
  byReviewStatus: Array<{ value: string; count: number }>;
  linkedToExperiment: number;
}

/**
 * The project dashboard's numbers, computed over the caller's visible set.
 *
 * Every figure here is derived from the same `visibility` filter the file listing uses,
 * so a project member without clearance for a restricted subfolder sees a smaller —
 * and honest — dashboard rather than a total that hints at what they cannot open.
 */
export async function projectContentBreakdown(
  visibility: Record<string, unknown>,
  projectId: string,
): Promise<ProjectContentBreakdown> {
  if (!isValidId(projectId)) {
    return {
      totalFiles: 0,
      totalBytes: 0,
      byCategory: [],
      byDocumentType: [],
      byReviewStatus: [],
      linkedToExperiment: 0,
    };
  }
  await connectToDatabase();

  const match = { $and: [visibility, { projectId: oid(projectId) }] };

  const [totals, categories, documentTypes, reviewStatuses, linked] = await Promise.all([
    FileModel.aggregate<{ count: number; bytes: number }>([
      { $match: match },
      { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: '$sizeBytes' } } },
    ]).exec(),
    FileModel.aggregate<{ _id: string; count: number; bytes: number }>([
      { $match: match },
      { $group: { _id: '$category', count: { $sum: 1 }, bytes: { $sum: '$sizeBytes' } } },
      { $sort: { count: -1 } },
    ]).exec(),
    FileModel.aggregate<{ _id: string | null; count: number; bytes: number }>([
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ['$metadata.documentType', 'unclassified'] },
          count: { $sum: 1 },
          bytes: { $sum: '$sizeBytes' },
        },
      },
      { $sort: { count: -1 } },
    ]).exec(),
    FileModel.aggregate<{ _id: string; count: number }>([
      { $match: match },
      { $group: { _id: '$reviewStatus', count: { $sum: 1 } } },
    ]).exec(),
    FileModel.countDocuments({
      $and: [visibility, { projectId: oid(projectId) }, { experimentId: { $ne: null } }],
    }).exec(),
  ]);

  return {
    totalFiles: totals[0]?.count ?? 0,
    totalBytes: totals[0]?.bytes ?? 0,
    byCategory: categories.map((row) => ({ value: row._id, count: row.count, bytes: row.bytes })),
    byDocumentType: documentTypes.map((row) => ({
      value: String(row._id ?? 'unclassified'),
      count: row.count,
      bytes: row.bytes,
    })),
    byReviewStatus: reviewStatuses.map((row) => ({ value: row._id, count: row.count })),
    linkedToExperiment: linked,
  };
}

/** Clears the experiment link on every file pointing at an experiment. */
export async function unlinkExperiment(
  experimentId: string,
  session?: ClientSession,
): Promise<number> {
  if (!isValidId(experimentId)) return 0;
  await connectToDatabase();
  const result = await FileModel.updateMany(
    { experimentId: oid(experimentId) },
    { $set: { experimentId: null } },
    session ? { session } : {},
  ).exec();
  return result.modifiedCount;
}

export async function existsWithName(
  folderId: string,
  displayNameLower: string,
  excludeId?: string,
): Promise<boolean> {
  await connectToDatabase();
  const filter: FilterQuery<FileDocument> = {
    folderId: oid(folderId),
    displayNameLower,
  };
  if (excludeId && isValidId(excludeId)) filter._id = { $ne: oid(excludeId) };
  return (await FileModel.countDocuments(filter).exec()) > 0;
}

export async function takenNamesInFolder(folderId: string): Promise<Set<string>> {
  if (!isValidId(folderId)) return new Set();
  await connectToDatabase();
  const docs = await FileModel.find({ folderId: oid(folderId) })
    .select({ displayNameLower: 1 })
    .limit(5000)
    .lean<Array<{ displayNameLower: string }>>()
    .exec();
  return new Set(docs.map((doc) => doc.displayNameLower));
}

/** Same bytes already stored in the same folder — used to warn about duplicate uploads. */
export async function findByChecksumInFolder(
  folderId: string,
  checksum: string,
): Promise<FileRecord | null> {
  await connectToDatabase();
  const doc = await FileModel.findOne({ folderId: oid(folderId), checksumSha256: checksum })
    .lean<LeanFile>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function countInFolder(folderId: string): Promise<number> {
  if (!isValidId(folderId)) return 0;
  await connectToDatabase();
  return FileModel.countDocuments({ folderId: oid(folderId) }).exec();
}

/* ----------------------------------------------------------------- writes */

/**
 * Mints an id before the document exists.
 *
 * The storage key contains the file id, and the bytes are moved into place *before* the
 * metadata is written — so the id has to exist first. Minting it here keeps ObjectId
 * construction inside the repository layer.
 */
export function newId(): string {
  return String(new Types.ObjectId());
}

export interface CreateFileInput {
  id?: string;
  organizationId: string;
  displayName: string;
  originalFilename: string;
  extension: string;
  category: FileCategory;
  folderId: string;
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
   * Overrides the timestamps. Only the Drive import sets these: an archive whose files
   * all claim to have been created on migration day is useless for provenance. Every
   * other caller lets the schema stamp `now`.
   *
   * Supplying `createdAt` turns Mongoose's automatic stamping off for this insert, so
   * `updatedAt` must be supplied with it or it would be left unset — and a document with
   * no `updatedAt` sorts unpredictably in every listing.
   */
  createdAt?: Date;
  updatedAt?: Date;
  createdBy: string;
}

export async function create(
  input: CreateFileInput,
  session?: ClientSession,
): Promise<FileRecord> {
  await connectToDatabase();
  const [doc] = await FileModel.create(
    [
      {
        ...(input.id ? { _id: oid(input.id) } : {}),
        organizationId: oid(input.organizationId),
        displayName: input.displayName,
        displayNameLower: input.displayName.toLowerCase(),
        originalFilename: input.originalFilename,
        extension: input.extension,
        category: input.category,
        folderId: oid(input.folderId),
        folderPathAncestors: input.folderPathAncestors.map(oid),
        driveType: input.driveType,
        ownerId: oid(input.ownerId),
        departmentId: input.departmentId ? oid(input.departmentId) : null,
        projectId: input.projectId ? oid(input.projectId) : null,
        confidentiality: input.confidentiality,
        sizeBytes: input.sizeBytes,
        mimeType: input.mimeType,
        checksumSha256: input.checksumSha256,
        tags: input.tags ?? [],
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.createdAt
          ? { createdAt: input.createdAt, updatedAt: input.updatedAt ?? input.createdAt }
          : {}),
        createdBy: oid(input.createdBy),
      },
    ],
    // `timestamps: false` only where explicit timestamps were supplied, so the schema
    // keeps stamping every other write.
    {
      ...(session ? { session } : {}),
      ...(input.createdAt ? { timestamps: false } : {}),
    },
  );
  return toRecord(doc!.toObject() as LeanFile);
}

export async function updateById(
  id: string,
  update: Record<string, unknown>,
  session?: ClientSession,
): Promise<FileRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const query = FileModel.findOneAndUpdate({ _id: oid(id) }, update, { new: true });
  if (session) query.session(session);
  const doc = await query.lean<LeanFile>().exec();
  return doc ? toRecord(doc) : null;
}

/**
 * A conditional update: applies only while the file still matches `expected`.
 *
 * The guard is the point. Clearing a file's approval because an older version's content
 * drifted is only correct if that version is still the one holding the approval — if a newer
 * one has been approved since, the read-then-write would silently undo it. Expressing the
 * condition in the filter makes that a no-op rather than a race.
 *
 * Returns null when nothing matched, which callers read as "somebody else changed it first".
 */
export async function updateByIdWhere(
  id: string,
  expected: Record<string, unknown>,
  update: Record<string, unknown>,
  session?: ClientSession,
): Promise<FileRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();

  const filter: Record<string, unknown> = { _id: oid(id) };
  for (const [path, value] of Object.entries(expected)) {
    /**
     * Only *reference* paths are coerced to ObjectIds, decided by the field name rather than
     * by what the value happens to look like. A file legitimately named
     * "0123456789abcdef01234567" would otherwise be turned into an ObjectId here, the filter
     * would match nothing, and the update would silently do nothing at all — the worst shape
     * of bug, because the caller is told the row simply changed underneath it.
     */
    const isReferencePath = path === '_id' || path.endsWith('Id');
    filter[path] =
      isReferencePath && typeof value === 'string' && isValidId(value) ? oid(value) : value;
  }

  const query = FileModel.findOneAndUpdate(filter, update, { new: true });
  if (session) query.session(session);
  const doc = await query.lean<LeanFile>().exec();
  return doc ? toRecord(doc) : null;
}

/** Restores a soft-deleted file; the default filter would otherwise hide it. */
export async function setDeleted(
  input: { fileId: string; deleted: boolean; userId: string; withFolderId?: string | null },
  session?: ClientSession,
): Promise<void> {
  await connectToDatabase();
  const sessionOption = session ? { session } : {};

  if (input.deleted) {
    await FileModel.updateOne(
      { _id: oid(input.fileId), deletedAt: null },
      {
        $set: {
          deletedAt: new Date(),
          deletedBy: oid(input.userId),
          status: 'trashed',
          trashedWithFolderId: input.withFolderId ? oid(input.withFolderId) : null,
        },
      },
      sessionOption,
    ).exec();
    return;
  }

  await FileModel.updateOne(
    { _id: oid(input.fileId), deletedAt: { $ne: null } },
    { $set: { deletedAt: null, deletedBy: null, status: 'active', trashedWithFolderId: null } },
    sessionOption,
  ).exec();
}

/**
 * Trashes or restores a file on nobody's behalf.
 *
 * `deletedBy` is left null rather than attributed to the owner or to an administrator,
 * because neither of them did it — somebody moved the object in Google Drive and the change
 * feed noticed. A false attribution in the one field that answers "who deleted this?" would
 * be worse than an empty one, and the audit entry records what actually happened.
 *
 * Returns whether anything changed, so a replayed change is a no-op the caller can see.
 */
export async function setDeletedBySystem(input: {
  fileId: string;
  deleted: boolean;
}): Promise<boolean> {
  if (!isValidId(input.fileId)) return false;
  await connectToDatabase();

  const result = input.deleted
    ? await FileModel.updateOne(
        { _id: oid(input.fileId), deletedAt: null },
        { $set: { deletedAt: new Date(), deletedBy: null, status: 'trashed', trashedWithFolderId: null } },
      ).exec()
    : await FileModel.updateOne(
        { _id: oid(input.fileId), deletedAt: { $ne: null } },
        { $set: { deletedAt: null, deletedBy: null, status: 'active', trashedWithFolderId: null } },
      )
        .setOptions({ withDeleted: true })
        .exec();

  return result.modifiedCount > 0;
}

/** Trashes or restores every file inside a folder subtree, alongside the folder move. */
export async function setSubtreeDeleted(
  input: { folderId: string; deleted: boolean; userId: string },
  session?: ClientSession,
): Promise<number> {
  await connectToDatabase();
  const folderOid = oid(input.folderId);
  const sessionOption = session ? { session } : {};

  if (input.deleted) {
    const result = await FileModel.updateMany(
      {
        $or: [{ folderId: folderOid }, { folderPathAncestors: folderOid }],
        deletedAt: null,
      },
      {
        $set: {
          deletedAt: new Date(),
          deletedBy: oid(input.userId),
          status: 'trashed',
          trashedWithFolderId: folderOid,
        },
      },
      sessionOption,
    ).exec();
    return result.modifiedCount;
  }

  const result = await FileModel.updateMany(
    {
      $or: [{ folderId: folderOid }, { folderPathAncestors: folderOid }],
      trashedWithFolderId: folderOid,
      deletedAt: { $ne: null },
    },
    { $set: { deletedAt: null, deletedBy: null, status: 'active', trashedWithFolderId: null } },
    sessionOption,
  ).exec();
  return result.modifiedCount;
}

/** Keeps files in step with the folder subtree they live in after a move. */
export async function reparentSubtree(
  input: {
    folderId: string;
    newPathAncestorsForFolder: string[];
    driveType: string;
    departmentId: string | null;
    projectId: string | null;
  },
  session?: ClientSession,
): Promise<void> {
  await connectToDatabase();
  const folderOid = oid(input.folderId);
  const newAncestors = input.newPathAncestorsForFolder.map(oid);
  const sessionOption = session ? { session } : {};

  // Files directly in the moved folder.
  await FileModel.updateMany(
    { folderId: folderOid },
    {
      $set: {
        folderPathAncestors: [...newAncestors, folderOid],
        driveType: input.driveType,
        departmentId: input.departmentId ? oid(input.departmentId) : null,
        projectId: input.projectId ? oid(input.projectId) : null,
      },
    },
    sessionOption,
  ).exec();

  // Files further down: replace the prefix up to and including the moved folder.
  await FileModel.updateMany(
    { folderPathAncestors: folderOid },
    [
      {
        $set: {
          folderPathAncestors: {
            $concatArrays: [
              [...newAncestors, folderOid],
              {
                $slice: [
                  '$folderPathAncestors',
                  { $add: [{ $indexOfArray: ['$folderPathAncestors', folderOid] }, 1] },
                  { $size: '$folderPathAncestors' },
                ],
              },
            ],
          },
          driveType: input.driveType,
          departmentId: input.departmentId ? oid(input.departmentId) : null,
          projectId: input.projectId ? oid(input.projectId) : null,
        },
      },
    ],
    sessionOption,
  ).exec();
}

export async function setSubtreeStatus(
  input: { folderId: string; status: 'active' | 'archived' },
  session?: ClientSession,
): Promise<void> {
  await connectToDatabase();
  const folderOid = oid(input.folderId);
  await FileModel.updateMany(
    { $or: [{ folderId: folderOid }, { folderPathAncestors: folderOid }] },
    { $set: { status: input.status } },
    session ? { session } : {},
  ).exec();
}

export async function findExpiredTrash(before: Date, limit = 200): Promise<FileRecord[]> {
  await connectToDatabase();
  const docs = await FileModel.find({ deletedAt: { $ne: null, $lte: before } })
    .setOptions({ withDeleted: true })
    .limit(limit)
    .lean<LeanFile[]>()
    .exec();
  return docs.map(toRecord);
}

export async function purge(fileIds: string[], session?: ClientSession): Promise<number> {
  const valid = fileIds.filter(isValidId).map(oid);
  if (valid.length === 0) return 0;
  await connectToDatabase();
  const result = await FileModel.deleteMany(
    { _id: { $in: valid } },
    session ? { session } : undefined,
  ).exec();
  return result.deletedCount ?? 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
