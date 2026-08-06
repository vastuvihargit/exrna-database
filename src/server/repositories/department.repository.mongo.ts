/**
 * The MongoDB department repository — the implementation that serves production today.
 *
 * Unchanged from the pre-Phase-3 `department.repository.ts` except for the two signatures
 * narrowed to the neutral contract.
 */
import { Types, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { DepartmentModel, UserModel, type DepartmentDocument } from '@/server/db/models';
import type {
  CreateDepartmentInput,
  DepartmentPatch,
  DepartmentRecord,
  DepartmentRepository,
  ListDepartmentsCriteria,
} from './department.repository.contract';

type LeanDepartment = DepartmentDocument & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

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

function objectId(id: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
}

function toSet(patch: DepartmentPatch): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

export async function list(criteria: ListDepartmentsCriteria): Promise<DepartmentRecord[]> {
  await connectToDatabase();

  const organizationId = objectId(criteria.organizationId);
  if (!organizationId) return [];

  const filter: FilterQuery<DepartmentDocument> = { organizationId };
  // `department.model.ts` does not apply the soft-delete pre-hook, so the default listing
  // includes soft-deleted rows. See the note in the contract.
  if (criteria.includeDeleted === false) filter.deletedAt = null;

  const docs = await DepartmentModel.find(filter)
    .sort({ name: 1 })
    .lean<LeanDepartment[]>()
    .exec();
  return docs.map(toRecord);
}

export async function findById(id: string): Promise<DepartmentRecord | null> {
  const _id = objectId(id);
  if (!_id) return null;
  await connectToDatabase();
  const doc = await DepartmentModel.findOne({ _id }).lean<LeanDepartment>().exec();
  return doc ? toRecord(doc) : null;
}

export async function findByIds(ids: string[]): Promise<DepartmentRecord[]> {
  const valid = ids.map(objectId).filter((id): id is Types.ObjectId => id !== null);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await DepartmentModel.find({ _id: { $in: valid } })
    .lean<LeanDepartment[]>()
    .exec();
  return docs.map(toRecord);
}

export async function findByCode(
  organizationId: string,
  code: string,
): Promise<DepartmentRecord | null> {
  const orgId = objectId(organizationId);
  if (!orgId) return null;
  await connectToDatabase();
  const doc = await DepartmentModel.findOne({ organizationId: orgId, code: code.toUpperCase() })
    .lean<LeanDepartment>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function create(input: CreateDepartmentInput): Promise<DepartmentRecord> {
  await connectToDatabase();
  const [doc] = await DepartmentModel.create([
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
  ]);
  return toRecord(doc!.toObject() as LeanDepartment);
}

export async function updateById(
  id: string,
  patch: DepartmentPatch,
): Promise<DepartmentRecord | null> {
  const _id = objectId(id);
  if (!_id) return null;

  const $set = toSet(patch);
  if (Object.keys($set).length === 0) return findById(id);

  await connectToDatabase();
  const doc = await DepartmentModel.findOneAndUpdate({ _id }, { $set }, { new: true })
    .lean<LeanDepartment>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function softDelete(id: string, deletedBy: string): Promise<boolean> {
  const _id = objectId(id);
  if (!_id) return false;
  await connectToDatabase();
  const result = await DepartmentModel.updateOne(
    { _id },
    { $set: { deletedAt: new Date(), deletedBy: new Types.ObjectId(deletedBy), isActive: false } },
  ).exec();
  return result.modifiedCount > 0;
}

/** Recomputes member counts from the users collection — the counter is derived, never authoritative. */
export async function refreshMemberCount(departmentId: string): Promise<number> {
  const _id = objectId(departmentId);
  if (!_id) return 0;
  await connectToDatabase();
  const count = await UserModel.countDocuments({ departmentId: _id, status: 'active' }).exec();
  await DepartmentModel.updateOne({ _id }, { $set: { memberCount: count } }).exec();
  return count;
}

export const mongoDepartmentRepository: DepartmentRepository = {
  list,
  findById,
  findByIds,
  findByCode,
  create,
  updateById,
  softDelete,
  refreshMemberCount,
};
