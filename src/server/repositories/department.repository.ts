import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { DepartmentModel, UserModel, type DepartmentDocument } from '@/server/db/models';

export interface DepartmentRecord {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  description: string;
  headUserId: string | null;
  parentDepartmentId: string | null;
  rootFolderId: string | null;
  storageQuotaBytes: number;
  storageUsedBytes: number;
  memberCount: number;
  isActive: boolean;
  createdAt: Date;
}

type LeanDepartment = DepartmentDocument & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

function toRecord(doc: LeanDepartment): DepartmentRecord {
  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    name: doc.name,
    code: doc.code,
    description: doc.description ?? '',
    headUserId: doc.headUserId ? String(doc.headUserId) : null,
    parentDepartmentId: doc.parentDepartmentId ? String(doc.parentDepartmentId) : null,
    rootFolderId: doc.rootFolderId ? String(doc.rootFolderId) : null,
    storageQuotaBytes: doc.storageQuotaBytes,
    storageUsedBytes: doc.storageUsedBytes ?? 0,
    memberCount: doc.memberCount ?? 0,
    isActive: Boolean(doc.isActive),
    createdAt: doc.createdAt,
  };
}

export async function list(filter: FilterQuery<DepartmentDocument>): Promise<DepartmentRecord[]> {
  await connectToDatabase();
  const docs = await DepartmentModel.find(filter).sort({ name: 1 }).lean<LeanDepartment[]>().exec();
  return docs.map(toRecord);
}

export async function findById(id: string): Promise<DepartmentRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectToDatabase();
  const doc = await DepartmentModel.findOne({ _id: new Types.ObjectId(id) })
    .lean<LeanDepartment>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function findByIds(ids: string[]): Promise<DepartmentRecord[]> {
  const valid = ids.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await DepartmentModel.find({ _id: { $in: valid } }).lean<LeanDepartment[]>().exec();
  return docs.map(toRecord);
}

export async function findByCode(organizationId: string, code: string): Promise<DepartmentRecord | null> {
  await connectToDatabase();
  const doc = await DepartmentModel.findOne({
    organizationId: new Types.ObjectId(organizationId),
    code: code.toUpperCase(),
  })
    .lean<LeanDepartment>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export interface CreateDepartmentInput {
  organizationId: string;
  name: string;
  code: string;
  description?: string;
  headUserId?: string | null;
  parentDepartmentId?: string | null;
  storageQuotaBytes: number;
  createdBy: string;
}

export async function create(
  input: CreateDepartmentInput,
  session?: ClientSession,
): Promise<DepartmentRecord> {
  await connectToDatabase();
  const [doc] = await DepartmentModel.create(
    [
      {
        organizationId: new Types.ObjectId(input.organizationId),
        name: input.name,
        code: input.code.toUpperCase(),
        description: input.description ?? '',
        headUserId: input.headUserId ? new Types.ObjectId(input.headUserId) : null,
        parentDepartmentId: input.parentDepartmentId
          ? new Types.ObjectId(input.parentDepartmentId)
          : null,
        storageQuotaBytes: input.storageQuotaBytes,
        createdBy: new Types.ObjectId(input.createdBy),
      },
    ],
    session ? { session } : undefined,
  );
  return toRecord(doc!.toObject() as LeanDepartment);
}

export async function updateById(
  id: string,
  update: Record<string, unknown>,
): Promise<DepartmentRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectToDatabase();
  const doc = await DepartmentModel.findOneAndUpdate({ _id: new Types.ObjectId(id) }, update, {
    new: true,
  })
    .lean<LeanDepartment>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function softDelete(id: string, deletedBy: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(id)) return false;
  await connectToDatabase();
  const result = await DepartmentModel.updateOne(
    { _id: new Types.ObjectId(id) },
    { $set: { deletedAt: new Date(), deletedBy: new Types.ObjectId(deletedBy), isActive: false } },
  ).exec();
  return result.modifiedCount > 0;
}

/** Recomputes member counts from the users collection — the counter is derived, never authoritative. */
export async function refreshMemberCount(departmentId: string): Promise<number> {
  if (!Types.ObjectId.isValid(departmentId)) return 0;
  await connectToDatabase();
  const _id = new Types.ObjectId(departmentId);
  const count = await UserModel.countDocuments({ departmentId: _id, status: 'active' }).exec();
  await DepartmentModel.updateOne({ _id }, { $set: { memberCount: count } }).exec();
  return count;
}
