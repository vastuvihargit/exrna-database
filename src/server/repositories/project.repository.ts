import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { ProjectModel, UserModel, type ProjectDocument, type ProjectStatus } from '@/server/db/models';
import type { ConfidentialityLevel } from '@/server/domain/permissions';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export interface ProjectRecord {
  id: string;
  organizationId: string;
  departmentId: string;
  name: string;
  code: string;
  description: string;
  leadUserId: string | null;
  memberUserIds: string[];
  rootFolderId: string | null;
  status: ProjectStatus;
  confidentiality: ConfidentialityLevel;
  startDate: Date | null;
  targetEndDate: Date | null;
  completedAt: Date | null;
  tags: string[];
  storageUsedBytes: number;
  fileCount: number;
  createdAt: Date;
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
  if (!Types.ObjectId.isValid(id)) return null;
  await connectToDatabase();
  const doc = await ProjectModel.findOne({ _id: oid(id) }).lean<LeanProject>().exec();
  return doc ? toRecord(doc) : null;
}

export async function findByIds(ids: string[]): Promise<ProjectRecord[]> {
  const valid = ids.filter((id) => Types.ObjectId.isValid(id)).map(oid);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await ProjectModel.find({ _id: { $in: valid } }).lean<LeanProject[]>().exec();
  return docs.map(toRecord);
}

export async function findByCode(
  organizationId: string,
  code: string,
): Promise<ProjectRecord | null> {
  await connectToDatabase();
  const doc = await ProjectModel.findOne({
    organizationId: oid(organizationId),
    code: code.toUpperCase(),
  })
    .lean<LeanProject>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function list(
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

/**
 * Projects an actor may see, expressed as one query.
 *
 * The filter is built here rather than in the service so that no layer above the
 * repository has to know about ObjectIds — services deal in string ids only.
 */
export async function listVisible(input: {
  organizationId: string;
  companyWide: boolean;
  userId: string;
  departmentId: string | null;
  departmentScopeIds: string[];
  projectScopeIds: string[];
}): Promise<ProjectRecord[]> {
  const organizationId = oid(input.organizationId);
  if (input.companyWide) return list({ organizationId });

  const branches: FilterQuery<ProjectDocument>[] = [
    { memberUserIds: oid(input.userId) },
    { leadUserId: oid(input.userId) },
  ];
  if (input.departmentId) branches.push({ departmentId: oid(input.departmentId) });
  if (input.departmentScopeIds.length) {
    branches.push({ departmentId: { $in: input.departmentScopeIds.map(oid) } });
  }
  if (input.projectScopeIds.length) {
    branches.push({ _id: { $in: input.projectScopeIds.map(oid) } });
  }

  return list({ organizationId, $or: branches });
}

export interface CreateProjectInput {
  organizationId: string;
  departmentId: string;
  name: string;
  code: string;
  description?: string;
  leadUserId?: string | null;
  memberUserIds?: string[];
  confidentiality: ConfidentialityLevel;
  startDate?: Date | null;
  targetEndDate?: Date | null;
  tags?: string[];
  createdBy: string;
}

export async function create(
  input: CreateProjectInput,
  session?: ClientSession,
): Promise<ProjectRecord> {
  await connectToDatabase();
  const [doc] = await ProjectModel.create(
    [
      {
        organizationId: oid(input.organizationId),
        departmentId: oid(input.departmentId),
        name: input.name,
        code: input.code.toUpperCase(),
        description: input.description ?? '',
        leadUserId: input.leadUserId ? oid(input.leadUserId) : null,
        memberUserIds: (input.memberUserIds ?? []).map(oid),
        confidentiality: input.confidentiality,
        startDate: input.startDate ?? null,
        targetEndDate: input.targetEndDate ?? null,
        tags: input.tags ?? [],
        createdBy: oid(input.createdBy),
      },
    ],
    session ? { session } : undefined,
  );
  return toRecord(doc!.toObject() as LeanProject);
}

export async function updateById(
  id: string,
  update: Record<string, unknown>,
  session?: ClientSession,
): Promise<ProjectRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectToDatabase();
  const query = ProjectModel.findOneAndUpdate({ _id: oid(id) }, update, { new: true });
  if (session) query.session(session);
  const doc = await query.lean<LeanProject>().exec();
  return doc ? toRecord(doc) : null;
}

/**
 * Project membership is denormalized onto users as `projectIds` so the visibility
 * filter stays a single query. Both sides are written together.
 */
export async function syncMembership(
  projectId: string,
  memberUserIds: string[],
  session?: ClientSession,
): Promise<void> {
  await connectToDatabase();
  const projectOid = oid(projectId);
  const memberOids = memberUserIds.map(oid);
  const sessionOption = session ? { session } : {};

  await UserModel.updateMany(
    { projectIds: projectOid, _id: { $nin: memberOids } },
    { $pull: { projectIds: projectOid } },
    sessionOption,
  ).exec();

  if (memberOids.length > 0) {
    await UserModel.updateMany(
      { _id: { $in: memberOids } },
      { $addToSet: { projectIds: projectOid } },
      sessionOption,
    ).exec();
  }
}

export async function softDelete(id: string, deletedBy: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(id)) return false;
  await connectToDatabase();
  const result = await ProjectModel.updateOne(
    { _id: oid(id) },
    { $set: { deletedAt: new Date(), deletedBy: oid(deletedBy), status: 'archived' } },
  ).exec();
  return result.modifiedCount > 0;
}
