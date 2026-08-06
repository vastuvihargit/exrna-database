/**
 * The MongoDB project repository — the implementation that serves production today.
 *
 * The query logic is unchanged. What moved is *where the transaction lives*: `create` and
 * `updateById` now open their own session and write the project row and its membership
 * together, instead of accepting a session from `project.service.ts`. Same two writes, same
 * atomicity, one less MongoDB concept above the repository line.
 */
import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { connectToDatabase, withTransaction } from '@/server/db/connection';
import {
  ProjectModel,
  UserModel,
  type ProjectDocument,
  type ProjectStatus,
} from '@/server/db/models';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type {
  CreateProjectInput,
  ProjectPatch,
  ProjectRecord,
  ProjectRepository,
  VisibleProjectsInput,
} from './project.repository.contract';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

function maybeOid(value: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : null;
}

type LeanProject = ProjectDocument & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

function toRecord(doc: LeanProject): ProjectRecord {
  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    departmentId: String(doc.departmentId),
    name: doc.name,
    code: doc.code,
    description: doc.description ?? '',
    leadUserId: doc.leadUserId ? String(doc.leadUserId) : null,
    memberUserIds: (doc.memberUserIds ?? []).map(String),
    rootFolderId: doc.rootFolderId ? String(doc.rootFolderId) : null,
    status: doc.status as ProjectStatus,
    confidentiality: doc.confidentiality as ConfidentialityLevel,
    startDate: doc.startDate ?? null,
    targetEndDate: doc.targetEndDate ?? null,
    completedAt: doc.completedAt ?? null,
    tags: doc.tags ?? [],
    storageUsedBytes: doc.storageUsedBytes ?? 0,
    fileCount: doc.fileCount ?? 0,
    createdAt: doc.createdAt,
  };
}

export async function findById(id: string): Promise<ProjectRecord | null> {
  const _id = maybeOid(id);
  if (!_id) return null;
  await connectToDatabase();
  const doc = await ProjectModel.findOne({ _id }).lean<LeanProject>().exec();
  return doc ? toRecord(doc) : null;
}

export async function findByIds(ids: string[]): Promise<ProjectRecord[]> {
  const valid = ids.map(maybeOid).filter((id): id is Types.ObjectId => id !== null);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await ProjectModel.find({ _id: { $in: valid } }).lean<LeanProject[]>().exec();
  return docs.map(toRecord);
}

export async function findByCode(
  organizationId: string,
  code: string,
): Promise<ProjectRecord | null> {
  const orgId = maybeOid(organizationId);
  if (!orgId) return null;
  await connectToDatabase();
  const doc = await ProjectModel.findOne({ organizationId: orgId, code: code.toUpperCase() })
    .lean<LeanProject>()
    .exec();
  return doc ? toRecord(doc) : null;
}

async function list(
  filter: FilterQuery<ProjectDocument>,
  options: { limit?: number } = {},
): Promise<ProjectRecord[]> {
  await connectToDatabase();
  const docs = await ProjectModel.find(filter)
    .sort({ name: 1 })
    .limit(options.limit ?? 500)
    .lean<LeanProject[]>()
    .exec();
  return docs.map(toRecord);
}

export async function listVisible(input: VisibleProjectsInput): Promise<ProjectRecord[]> {
  const organizationId = maybeOid(input.organizationId);
  if (!organizationId) return [];
  if (input.companyWide) return list({ organizationId });

  const userId = maybeOid(input.userId);
  const branches: FilterQuery<ProjectDocument>[] = [];
  if (userId) branches.push({ memberUserIds: userId }, { leadUserId: userId });

  const departmentId = input.departmentId ? maybeOid(input.departmentId) : null;
  if (departmentId) branches.push({ departmentId });

  const departmentScopeIds = input.departmentScopeIds
    .map(maybeOid)
    .filter((id): id is Types.ObjectId => id !== null);
  if (departmentScopeIds.length) branches.push({ departmentId: { $in: departmentScopeIds } });

  const projectScopeIds = input.projectScopeIds
    .map(maybeOid)
    .filter((id): id is Types.ObjectId => id !== null);
  if (projectScopeIds.length) branches.push({ _id: { $in: projectScopeIds } });

  // No branches means no way in — return nothing rather than an unfiltered organization list.
  if (branches.length === 0) return [];

  return list({ organizationId, $or: branches });
}

/**
 * Project membership is denormalized onto users as `projectIds` so the visibility filter
 * stays a single query. Both sides are written together.
 */
async function syncMembership(
  projectId: string,
  memberUserIds: string[],
  session: ClientSession,
): Promise<void> {
  const projectOid = oid(projectId);
  const memberOids = memberUserIds.map(oid);

  await UserModel.updateMany(
    { projectIds: projectOid, _id: { $nin: memberOids } },
    { $pull: { projectIds: projectOid } },
    { session },
  ).exec();

  if (memberOids.length > 0) {
    await UserModel.updateMany(
      { _id: { $in: memberOids } },
      { $addToSet: { projectIds: projectOid } },
      { session },
    ).exec();
  }
}

export async function create(input: CreateProjectInput): Promise<ProjectRecord> {
  await connectToDatabase();
  const members = input.memberUserIds ?? [];

  return withTransaction(async (session) => {
    const [doc] = await ProjectModel.create(
      [
        {
          organizationId: oid(input.organizationId),
          departmentId: oid(input.departmentId),
          name: input.name,
          code: input.code.toUpperCase(),
          description: input.description ?? '',
          leadUserId: input.leadUserId ? oid(input.leadUserId) : null,
          memberUserIds: members.map(oid),
          confidentiality: input.confidentiality,
          startDate: input.startDate ?? null,
          targetEndDate: input.targetEndDate ?? null,
          tags: input.tags ?? [],
          createdBy: oid(input.createdBy),
        },
      ],
      { session },
    );

    const created = toRecord(doc!.toObject() as LeanProject);
    await syncMembership(created.id, members, session);
    return created;
  });
}

function toSet(patch: ProjectPatch): Record<string, unknown> {
  const $set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // Ids are stored as ObjectIds; the contract speaks strings.
    if (key === 'leadUserId' || key === 'rootFolderId') {
      $set[key] = value === null ? null : oid(value as string);
    } else if (key === 'memberUserIds') {
      $set[key] = (value as string[]).map(oid);
    } else {
      $set[key] = value;
    }
  }
  return $set;
}

export async function updateById(
  id: string,
  patch: ProjectPatch,
): Promise<ProjectRecord | null> {
  const _id = maybeOid(id);
  if (!_id) return null;

  const $set = toSet(patch);
  if (Object.keys($set).length === 0) return findById(id);

  await connectToDatabase();

  return withTransaction(async (session) => {
    const doc = await ProjectModel.findOneAndUpdate({ _id }, { $set }, { new: true })
      .session(session)
      .lean<LeanProject>()
      .exec();
    if (!doc) return null;

    if (patch.memberUserIds !== undefined) {
      await syncMembership(id, patch.memberUserIds, session);
    }
    return toRecord(doc);
  });
}

export async function softDelete(id: string, deletedBy: string): Promise<boolean> {
  const _id = maybeOid(id);
  if (!_id) return false;
  await connectToDatabase();
  const result = await ProjectModel.updateOne(
    { _id },
    { $set: { deletedAt: new Date(), deletedBy: oid(deletedBy), status: 'archived' } },
  ).exec();
  return result.modifiedCount > 0;
}

export const mongoProjectRepository: ProjectRepository = {
  findById,
  findByIds,
  findByCode,
  listVisible,
  create,
  updateById,
  softDelete,
};
