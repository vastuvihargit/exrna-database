/**
 * The MongoDB file repository, behind the database-neutral contract.
 *
 * The queries are the ones that have always run. What changed is the *boundary*: visibility
 * filters are built here from an `Actor` rather than handed in by the service as a
 * `Record<string, unknown>`, and `updateById` translates a `FilePatch` into the update document
 * it used to receive ready-made. Everything a query actually does — the filters, the sorts, the
 * pagination, the aggregation pipelines, the soft-delete handling — is unchanged, because this
 * is the implementation that must keep serving production while D1 is written and proved.
 *
 * ── Which filter each read uses, and why it is not a choice made here ───────────────────
 *
 * Every read below applies exactly the filter its caller used to pass, so the refactor cannot
 * quietly widen or narrow what anybody sees:
 *
 *   findById / findByIds        `lookupGuardFilter`     — see below
 *   listInFolder / listTrashed  `childVisibilityFilter` — children of an already-authorised folder
 *   search / searchFacets       `resourceVisibilityFilter`
 *   findRelated                 `resourceVisibilityFilter`
 *   projectContentBreakdown     `resourceVisibilityFilter`
 *   listSharedWith              principals only — an explicit grant *is* the definition
 *
 * ── `findById` is the one behavioural change, and it is deliberately a narrow one ───────
 *
 * The old signature took no actor at all and returned any row in the database, leaving the
 * whole decision to `file-access.ts`. It now applies `lookupGuardFilter`: organization
 * isolation and the live deny guard, both inside the query.
 *
 * It deliberately does **not** apply `resourceLookupFilter`. That filter matches the ACL on
 * the document itself, and a file's access is usually *inherited* from the folder it lives in —
 * so using it here 404s the ordinary case of "somebody shared a folder with me and I opened a
 * file inside it". A lookup predicate that is narrower than `canAccess` is not a security
 * improvement, it is an outage. `lookupGuardFilter` documents the reasoning in full.
 *
 * The two guards it does apply are both implied by `canAccess` allowing the row, so nothing
 * legitimate can 404, while the two cases that matter for a guessed id — another tenant's file,
 * and one the actor was explicitly denied — can no longer be loaded at all. `assertCan` runs
 * immediately afterwards with the full ancestor chain and makes the real decision.
 *
 * D1 does not have this limitation: `file_folder_ancestors` turns "does an in-scope ancestor
 * grant this actor?" into a correlated sub-query, which is what `lookupVisibility()` in
 * `visibility.d1.ts` already does. The full in-query predicate arrives with that implementation.
 */
import { Types, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { FileModel, FileVersionModel, type FileDocument } from '@/server/db/models';
import { getLogger } from '@/server/logging/logger';
import type { AclEntry, Actor } from '@/server/permissions/actor';
import {
  childVisibilityFilter,
  lookupGuardFilter,
  resourceVisibilityFilter,
} from '@/server/permissions/visibility';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type { FileCategory } from '@/server/domain/file-types';
import type {
  CreateFileInput,
  FileGuard,
  FileHierarchyProblem,
  FilePage,
  FilePatch,
  FileRecord,
  FileRepository,
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ reads */

export async function findById(
  actor: Actor,
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<FileRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const query = FileModel.findOne({
    $and: [lookupGuardFilter(actor) as FilterQuery<FileDocument>, { _id: oid(id) }],
  } as FilterQuery<FileDocument>);
  if (options.includeDeleted) query.setOptions({ withDeleted: true });
  const doc = await query.lean<LeanFile>().exec();
  return doc ? toRecord(doc) : null;
}

export async function findByIds(actor: Actor, ids: string[]): Promise<FileRecord[]> {
  const valid = ids.filter(isValidId).map(oid);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await FileModel.find({
    $and: [lookupGuardFilter(actor) as FilterQuery<FileDocument>, { _id: { $in: valid } }],
  } as FilterQuery<FileDocument>)
    .lean<LeanFile[]>()
    .exec();
  return docs.map(toRecord);
}

export async function listInFolder(input: ListInFolderInput): Promise<FilePage> {
  await connectToDatabase();

  const conditions: Record<string, unknown>[] = [
    childVisibilityFilter(input.actor),
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

export async function listTrashed(input: ListForActorInput): Promise<FilePage> {
  await connectToDatabase();
  const filter = {
    $and: [
      childVisibilityFilter(input.actor),
      {
        organizationId: oid(input.actor.organizationId),
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
 * With a text term the sort is by relevance and the projection carries `textScore`; without one
 * it is an ordinary indexed filter query, which is what makes "everything in this project
 * tagged `qpcr`" fast without a search term at all.
 */
export async function search(input: SearchFilesInput): Promise<FilePage> {
  await connectToDatabase();

  const conditions: Record<string, unknown>[] = [
    resourceVisibilityFilter(input.actor),
    { organizationId: oid(input.actor.organizationId) },
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
 * Not "everything visible": role scope already gives a department head their whole department,
 * and listing that here would drown the one file a colleague actually handed over.
 * `excludeOwnerId` drops the actor's own files for the same reason.
 *
 * Denies are excluded in the query rather than filtered afterwards — an entry that says "you
 * may not open this" is not a share, and surfacing it would announce the existence of something
 * the actor was specifically blocked from.
 */
export async function listSharedWith(input: ListSharedWithInput): Promise<FilePage> {
  const principals = input.principalIds.filter(isValidId).map(oid);
  if (principals.length === 0) return { items: [], total: 0 };

  await connectToDatabase();

  const filter = {
    organizationId: oid(input.actor.organizationId),
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
export async function searchFacets(actor: Actor): Promise<SearchFacets> {
  await connectToDatabase();
  const match = {
    $and: [resourceVisibilityFilter(actor), { organizationId: oid(actor.organizationId) }],
  };

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
 * "Related" is four different questions the platform is asked constantly — same experiment,
 * same sample id, same experiment code, same checksum — and answering them separately would
 * mean four round trips and four permission passes.
 */
export async function findRelated(input: FindRelatedInput): Promise<FileRecord[]> {
  await connectToDatabase();

  const branches: Record<string, unknown>[] = [];
  if (input.experimentId) branches.push({ experimentId: oid(input.experimentId) });
  if (input.sampleId) branches.push({ 'metadata.sampleId': input.sampleId });
  if (input.experimentCode) branches.push({ 'metadata.experimentCode': input.experimentCode });
  if (input.checksumSha256) branches.push({ checksumSha256: input.checksumSha256 });
  if (branches.length === 0) return [];

  const filter = {
    $and: [
      resourceVisibilityFilter(input.actor),
      { organizationId: oid(input.actor.organizationId) },
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
 * The project dashboard's numbers, computed over the caller's visible set.
 *
 * Every figure is derived from the same visibility filter the file listing uses, so a project
 * member without clearance for a restricted subfolder sees a smaller — and honest — dashboard
 * rather than a total that hints at what they cannot open.
 */
export async function projectContentBreakdown(
  actor: Actor,
  projectId: string,
): Promise<ProjectContentBreakdown> {
  const empty: ProjectContentBreakdown = {
    totalFiles: 0,
    totalBytes: 0,
    byCategory: [],
    byDocumentType: [],
    byReviewStatus: [],
    linkedToExperiment: 0,
  };
  if (!isValidId(projectId)) return empty;
  await connectToDatabase();

  const visibility = resourceVisibilityFilter(actor);
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

/* ------------------------------------------------------------------ structural reads */

export async function existsWithName(
  folderId: string,
  displayNameLower: string,
  excludeId?: string,
): Promise<boolean> {
  await connectToDatabase();
  const filter: FilterQuery<FileDocument> = { folderId: oid(folderId), displayNameLower };
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

export async function countForExperiment(experimentId: string): Promise<number> {
  if (!isValidId(experimentId)) return 0;
  await connectToDatabase();
  return FileModel.countDocuments({ experimentId: oid(experimentId) }).exec();
}

/* ------------------------------------------------------------------ bypasses */

export async function findByIdInternal(
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

export async function findByIdsInternal(ids: string[]): Promise<FileRecord[]> {
  const valid = ids.filter(isValidId).map(oid);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await FileModel.find({ _id: { $in: valid } }).lean<LeanFile[]>().exec();
  return docs.map(toRecord);
}

/**
 * Raised when one Drive file id is claimed by versions belonging to more than one file.
 *
 * A unique partial index on `fileversions.googleDriveFileId` is supposed to make this
 * impossible. If it happens anyway the mirror has genuinely diverged, and picking whichever
 * file the query happened to return first would file a Drive change against an arbitrary one
 * of them — a silent, unattributable data corruption. Failing loudly is the only honest
 * outcome, and the log line carries what an operator needs to repair it.
 */
export class AmbiguousDriveFileError extends Error {
  constructor(
    readonly googleDriveFileId: string,
    readonly fileIds: string[],
  ) {
    super(
      `Google Drive file ${googleDriveFileId} is linked to ${fileIds.length} different files ` +
        `(${fileIds.join(', ')}). Refusing to guess which one a change belongs to.`,
    );
    this.name = 'AmbiguousDriveFileError';
  }
}

/**
 * The application file a mirrored Drive file belongs to.
 *
 * ⚠️ Authorization bypass. The Drive change feed starts from a Drive id and works backwards,
 * and runs as the sync worker rather than as a user.
 *
 * ── Why this reads `file_versions` ──────────────────────────────────────────────────────
 *
 * **No Drive id is stored on the file.** `file.model.ts` states the rule — a `File` never holds
 * a storage location, so a physical address cannot leak through a file listing however
 * carelessly it is serialized — and the D1 schema repeats it. Drive ids live on versions, so
 * the lookup is `googleDriveFileId → version → fileId → file`.
 *
 * That is the *only* thing this method takes from the version domain. It reads two columns to
 * resolve an id and returns a `FileRecord`; no version business logic, no version record, and
 * nothing about which version is current or approved. The file-version module has not started.
 *
 * Trashed files are included on purpose: a change arriving for a file that has since been
 * trashed here must still be recognised as *ours*, or the sync files it as an unmanaged item
 * and the mirror's disagreement is never reported.
 */
export async function findByDriveFileIdInternal(
  googleDriveFileId: string,
): Promise<FileRecord | null> {
  if (!googleDriveFileId) return null;
  await connectToDatabase();

  // Two, not one: the second row is what distinguishes "resolved" from "ambiguous", and a
  // `findOne` could never tell the difference.
  const versions = await FileVersionModel.find({ googleDriveFileId })
    .select({ fileId: 1 })
    .limit(2)
    .lean<Array<{ _id: Types.ObjectId; fileId: Types.ObjectId }>>()
    .exec();

  if (versions.length === 0) return null;

  const fileIds = [...new Set(versions.map((version) => String(version.fileId)))];
  if (fileIds.length > 1) {
    getLogger().error(
      { googleDriveFileId, fileIds },
      'One Google Drive file is linked to several application files; refusing to resolve it',
    );
    throw new AmbiguousDriveFileError(googleDriveFileId, fileIds);
  }

  return findByIdInternal(fileIds[0]!, { includeDeleted: true });
}

/**
 * Any live file in this organization with exactly these bytes.
 *
 * ⚠️ Bypass, deliberately: a storage decision rather than a listing. The Drive import uses it
 * to avoid storing a third copy of a file two people already saved twice, and the caller
 * reports "already present" without ever disclosing where the existing copy is.
 */
export async function findByChecksumInternal(
  organizationId: string,
  checksumSha256: string,
): Promise<FileRecord | null> {
  if (!checksumSha256) return null;
  await connectToDatabase();
  const doc = await FileModel.findOne({ organizationId: oid(organizationId), checksumSha256 })
    .lean<LeanFile>()
    .exec();
  return doc ? toRecord(doc) : null;
}

/** ⚠️ Bypass: the retention purge job's cursor. Runs as no user. */
export async function findExpiredTrashInternal(
  before: Date,
  limit = 200,
): Promise<FileRecord[]> {
  await connectToDatabase();
  const docs = await FileModel.find({ deletedAt: { $ne: null, $lte: before } })
    .setOptions({ withDeleted: true })
    .limit(limit)
    .lean<LeanFile[]>()
    .exec();
  return docs.map(toRecord);
}

/* ------------------------------------------------------------------ writes */

/**
 * Mints an id before the document exists.
 *
 * The storage key contains the file id and the bytes are moved into place *before* the metadata
 * is written, so the id has to exist first. Minting it here keeps ObjectId construction inside
 * the repository layer.
 */
export function newId(): string {
  return String(new Types.ObjectId());
}

export async function create(input: CreateFileInput, tx?: FileTx): Promise<FileRecord> {
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
    // `timestamps: false` only where explicit timestamps were supplied, so the schema keeps
    // stamping every other write.
    {
      ...(tx ? { session: tx } : {}),
      ...(input.createdAt ? { timestamps: false } : {}),
    },
  );
  return toRecord(doc!.toObject() as LeanFile);
}

/**
 * Translates a `FilePatch` into the update document this repository used to be handed.
 *
 * The mapping is deliberately explicit rather than a spread of the patch object: an unknown key
 * arriving from a caller must not become a `$set` on a field the schema has never heard of, and
 * `metadataSet`/`metadataUnset` have to become dotted paths rather than replacing the whole
 * sub-document — which is what `$set: { metadata }` would do, silently discarding every key the
 * caller did not mention.
 */
function toUpdate(patch: FilePatch): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  const unset: Record<string, string> = {};
  const inc: Record<string, number> = {};

  if (patch.displayName !== undefined) {
    set.displayName = patch.displayName;
    // Never written separately: the two must not be able to disagree.
    set.displayNameLower = patch.displayName.toLowerCase();
  }
  if (patch.originalFilename !== undefined) set.originalFilename = patch.originalFilename;
  if (patch.category !== undefined) set.category = patch.category;
  if (patch.folderId !== undefined) set.folderId = oid(patch.folderId);
  if (patch.folderPathAncestors !== undefined) {
    set.folderPathAncestors = patch.folderPathAncestors.map(oid);
  }
  if (patch.driveType !== undefined) set.driveType = patch.driveType;
  if (patch.ownerId !== undefined) set.ownerId = oid(patch.ownerId);
  if (patch.departmentId !== undefined) {
    set.departmentId = patch.departmentId ? oid(patch.departmentId) : null;
  }
  if (patch.projectId !== undefined) {
    set.projectId = patch.projectId ? oid(patch.projectId) : null;
  }
  if (patch.experimentId !== undefined) {
    set.experimentId = patch.experimentId ? oid(patch.experimentId) : null;
  }
  if (patch.confidentiality !== undefined) set.confidentiality = patch.confidentiality;
  if (patch.reviewStatus !== undefined) set.reviewStatus = patch.reviewStatus;
  if (patch.approvalStatus !== undefined) set.approvalStatus = patch.approvalStatus;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.currentVersionId !== undefined) {
    set.currentVersionId = patch.currentVersionId ? oid(patch.currentVersionId) : null;
  }
  if (patch.approvedVersionId !== undefined) {
    set.approvedVersionId = patch.approvedVersionId ? oid(patch.approvedVersionId) : null;
  }
  if (patch.sizeBytes !== undefined) set.sizeBytes = patch.sizeBytes;
  if (patch.mimeType !== undefined) set.mimeType = patch.mimeType;
  if (patch.checksumSha256 !== undefined) set.checksumSha256 = patch.checksumSha256;
  if (patch.hasGoogleNativeContent !== undefined) {
    set.hasGoogleNativeContent = patch.hasGoogleNativeContent;
  }
  if (patch.storageProvider !== undefined) set.storageProvider = patch.storageProvider;
  if (patch.inheritPermissions !== undefined) set.inheritPermissions = patch.inheritPermissions;
  if (patch.permissions !== undefined) {
    set.permissions = patch.permissions.map((entry) => ({
      principalType: entry.principalType,
      principalId: oid(entry.principalId),
      accessLevel: entry.accessLevel,
      deny: Boolean(entry.deny),
      expiresAt: entry.expiresAt ?? null,
      ...(entry.grantedBy ? { grantedBy: oid(entry.grantedBy) } : {}),
    }));
  }
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.updatedBy !== undefined) {
    set.updatedBy = patch.updatedBy ? oid(patch.updatedBy) : null;
  }
  if (patch.lastAccessedAt !== undefined) set.lastAccessedAt = patch.lastAccessedAt;

  for (const [key, value] of Object.entries(patch.metadataSet ?? {})) {
    set[`metadata.${key}`] = value;
  }
  for (const key of patch.metadataUnset ?? []) {
    unset[`metadata.${key}`] = '';
  }

  if (patch.versionCountDelta !== undefined) inc.versionCount = patch.versionCountDelta;
  if (patch.downloadCountDelta !== undefined) inc.downloadCount = patch.downloadCountDelta;

  return {
    ...(Object.keys(set).length > 0 ? { $set: set } : {}),
    ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
    ...(Object.keys(inc).length > 0 ? { $inc: inc } : {}),
  };
}

export async function updateById(
  id: string,
  patch: FilePatch,
  tx?: FileTx,
): Promise<FileRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const update = toUpdate(patch);
  // An empty patch is a no-op read rather than an error: callers assemble patches
  // conditionally, and `{}` reaching Mongoose would be an update with no operators.
  if (Object.keys(update).length === 0) return findByIdInternal(id);

  const query = FileModel.findOneAndUpdate({ _id: oid(id) }, update, { new: true });
  if (tx) query.session(tx);
  const doc = await query.lean<LeanFile>().exec();
  return doc ? toRecord(doc) : null;
}

/**
 * A conditional update: applies only while the file still matches `guard`.
 *
 * The guard is the point. Clearing a file's approval because an older version's content drifted
 * is only correct if that version is still the one holding the approval — if a newer one has
 * been approved since, the read-then-write would silently undo it. Expressing the condition in
 * the filter makes that a no-op rather than a race.
 *
 * Returns null when nothing matched, which callers read as "somebody else changed it first".
 */
export async function updateByIdWhere(
  id: string,
  guard: FileGuard,
  patch: FilePatch,
  tx?: FileTx,
): Promise<FileRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();

  const filter: Record<string, unknown> = { _id: oid(id) };
  // Reference fields are coerced by *name*, never by what the value happens to look like: a
  // file legitimately named "0123456789abcdef01234567" would otherwise become an ObjectId, the
  // filter would match nothing, and the update would silently do nothing at all.
  if (guard.approvedVersionId !== undefined) {
    filter.approvedVersionId = guard.approvedVersionId ? oid(guard.approvedVersionId) : null;
  }
  if (guard.currentVersionId !== undefined) {
    filter.currentVersionId = guard.currentVersionId ? oid(guard.currentVersionId) : null;
  }
  if (guard.folderId !== undefined) filter.folderId = oid(guard.folderId);
  if (guard.displayName !== undefined) filter.displayName = guard.displayName;
  if (guard.reviewStatus !== undefined) filter.reviewStatus = guard.reviewStatus;
  if (guard.approvalStatus !== undefined) filter.approvalStatus = guard.approvalStatus;
  if (guard.status !== undefined) filter.status = guard.status;

  const query = FileModel.findOneAndUpdate(filter, toUpdate(patch), { new: true });
  if (tx) query.session(tx);
  const doc = await query.lean<LeanFile>().exec();
  return doc ? toRecord(doc) : null;
}

/** Restores a soft-deleted file; the default filter would otherwise hide it. */
export async function setDeleted(
  input: { fileId: string; deleted: boolean; userId: string; withFolderId?: string | null },
  tx?: FileTx,
): Promise<void> {
  await connectToDatabase();
  const sessionOption = tx ? { session: tx } : {};

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
 * ⚠️ Bypass: somebody moved the object in Google Drive and the change feed noticed.
 * `deletedBy` is left null rather than attributed to the owner or to an administrator, because
 * neither of them did it — a false attribution in the one field that answers "who deleted
 * this?" would be worse than an empty one, and the audit entry records what actually happened.
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
        {
          $set: {
            deletedAt: new Date(),
            deletedBy: null,
            status: 'trashed',
            trashedWithFolderId: null,
          },
        },
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
  tx?: FileTx,
): Promise<number> {
  await connectToDatabase();
  const folderOid = oid(input.folderId);
  const sessionOption = tx ? { session: tx } : {};

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
  input: ReparentSubtreeInput,
  tx?: FileTx,
): Promise<void> {
  await connectToDatabase();
  const folderOid = oid(input.folderId);
  const newAncestors = input.newPathAncestorsForFolder.map(oid);
  const sessionOption = tx ? { session: tx } : {};

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
  tx?: FileTx,
): Promise<void> {
  await connectToDatabase();
  const folderOid = oid(input.folderId);
  await FileModel.updateMany(
    { $or: [{ folderId: folderOid }, { folderPathAncestors: folderOid }] },
    { $set: { status: input.status } },
    tx ? { session: tx } : {},
  ).exec();
}

/** Clears the experiment link on every file pointing at an experiment. */
export async function unlinkExperiment(experimentId: string, tx?: FileTx): Promise<number> {
  if (!isValidId(experimentId)) return 0;
  await connectToDatabase();
  const result = await FileModel.updateMany(
    { experimentId: oid(experimentId) },
    { $set: { experimentId: null } },
    tx ? { session: tx } : {},
  ).exec();
  return result.modifiedCount;
}

/** ⚠️ Bypass: hard delete. Only the retention purge and the tests reach this. */
export async function purge(fileIds: string[], tx?: FileTx): Promise<number> {
  const valid = fileIds.filter(isValidId).map(oid);
  if (valid.length === 0) return 0;
  await connectToDatabase();
  const result = await FileModel.deleteMany(
    { _id: { $in: valid } },
    tx ? { session: tx } : undefined,
  ).exec();
  return result.deletedCount ?? 0;
}

/* ------------------------------------------------------------------ integrity */

/**
 * Everything wrong with the stored file hierarchy, or an empty list.
 *
 * `folderId` and `folderPathAncestors` are two representations of one truth, and a bug in a
 * subtree mutation shows up here as a disagreement between them. The MongoDB implementation
 * has no closure table to check, so it verifies what the document model can express: that the
 * ancestor array ends with the containing folder, that every ancestor exists and belongs to the
 * same organization, and that no Drive id is claimed by two files.
 */
export async function checkFileHierarchyIntegrity(
  organizationId: string,
): Promise<FileHierarchyProblem[]> {
  await connectToDatabase();
  const problems: FileHierarchyProblem[] = [];

  const files = await FileModel.find({ organizationId: oid(organizationId) })
    .select({ folderId: 1, folderPathAncestors: 1 })
    .setOptions({ withDeleted: true })
    .lean<Array<{ _id: Types.ObjectId; folderId: Types.ObjectId; folderPathAncestors: Types.ObjectId[] }>>()
    .exec();

  const { FolderModel } = await import('@/server/db/models');
  const folderRows = await FolderModel.find({})
    .select({ organizationId: 1 })
    .setOptions({ withDeleted: true })
    .lean<Array<{ _id: Types.ObjectId; organizationId: Types.ObjectId }>>()
    .exec();
  const organizationOf = new Map(
    folderRows.map((row) => [String(row._id), String(row.organizationId)]),
  );

  for (const file of files) {
    const fileId = String(file._id);
    const chain = (file.folderPathAncestors ?? []).map(String);
    const folderId = String(file.folderId);

    if (chain.length === 0) {
      problems.push({
        kind: 'missing_ancestor_rows',
        fileId,
        detail: 'no ancestor chain at all',
      });
    } else if (chain.at(-1) !== folderId) {
      problems.push({
        kind: 'folder_not_in_ancestors',
        fileId,
        detail: `folderId ${folderId} but deepest ancestor ${chain.at(-1)}`,
      });
    }

    if (!organizationOf.has(folderId)) {
      problems.push({
        kind: 'missing_folder',
        fileId,
        detail: `containing folder ${folderId} does not exist`,
      });
    }

    for (const ancestorId of chain) {
      const owner = organizationOf.get(ancestorId);
      if (owner === undefined) {
        problems.push({
          kind: 'missing_ancestor_rows',
          fileId,
          detail: `ancestor ${ancestorId} does not exist`,
        });
      } else if (owner !== organizationId) {
        problems.push({
          kind: 'cross_organization_ancestor',
          fileId,
          detail: `ancestor ${ancestorId} belongs to another organization`,
        });
      }
    }
  }

  const duplicates = await FileVersionModel.aggregate<{ _id: string; fileIds: Types.ObjectId[] }>([
    { $match: { googleDriveFileId: { $type: 'string' } } },
    { $group: { _id: '$googleDriveFileId', fileIds: { $addToSet: '$fileId' } } },
    { $match: { 'fileIds.1': { $exists: true } } },
  ]).exec();

  for (const row of duplicates) {
    problems.push({
      kind: 'duplicate_drive_id',
      fileId: String(row.fileIds[0]),
      detail: `Drive file ${row._id} is claimed by ${row.fileIds.length} files`,
    });
  }

  return problems;
}

export const mongoFileRepository: FileRepository = {
  findById,
  findByIds,
  listInFolder,
  listTrashed,
  search,
  listSharedWith,
  searchFacets,
  findRelated,
  projectContentBreakdown,
  existsWithName,
  takenNamesInFolder,
  findByChecksumInFolder,
  countInFolder,
  countForExperiment,
  findByIdInternal,
  findByIdsInternal,
  findByDriveFileIdInternal,
  findByChecksumInternal,
  findExpiredTrashInternal,
  newId,
  create,
  updateById,
  updateByIdWhere,
  setDeleted,
  setDeletedBySystem,
  setSubtreeDeleted,
  reparentSubtree,
  setSubtreeStatus,
  unlinkExperiment,
  purge,
  checkFileHierarchyIntegrity,
};
