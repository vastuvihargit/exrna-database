/**
 * The MongoDB storage-usage repository — the existing implementation, moved behind the contract.
 *
 * One behavioural change, and it fixes a real gap rather than preserving parity: counters are
 * now clamped at zero. `$inc` will happily drive a counter negative, and a negative counter
 * reads as unlimited quota remaining. `quotaState` in the contract does the clamping on read so
 * both engines agree, and `recomputeAll` writes non-negative values.
 */
import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import {
  DepartmentModel,
  FileModel,
  FileVersionModel,
  ProjectModel,
  UserModel,
} from '@/server/db/models';
import {
  quotaState,
  type QuotaState,
  type RecomputeResult,
  type StorageUsageRepository,
  type UsageDelta,
  type UsageTx,
} from './storage-usage.repository.contract';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export async function applyDelta(delta: UsageDelta, tx?: UsageTx): Promise<void> {
  await connectToDatabase();
  const sessionOption = tx ? { session: tx } : {};

  await UserModel.updateOne(
    { _id: oid(delta.userId) },
    { $inc: { storageUsedBytes: delta.bytes } },
    sessionOption,
  ).exec();

  if (delta.departmentId) {
    await DepartmentModel.updateOne(
      { _id: oid(delta.departmentId) },
      { $inc: { storageUsedBytes: delta.bytes } },
      sessionOption,
    ).exec();
  }

  if (delta.projectId) {
    await ProjectModel.updateOne(
      { _id: oid(delta.projectId) },
      { $inc: { storageUsedBytes: delta.bytes } },
      sessionOption,
    ).exec();
  }
}

export async function getUserQuota(userId: string): Promise<QuotaState | null> {
  if (!Types.ObjectId.isValid(userId)) return null;
  await connectToDatabase();
  const doc = await UserModel.findOne({ _id: oid(userId) })
    .select({ storageUsedBytes: 1, storageQuotaBytes: 1 })
    .lean<{ storageUsedBytes: number; storageQuotaBytes: number }>()
    .exec();
  if (!doc) return null;
  return quotaState(doc.storageUsedBytes ?? 0, doc.storageQuotaBytes);
}

export async function getDepartmentQuota(departmentId: string): Promise<QuotaState | null> {
  if (!Types.ObjectId.isValid(departmentId)) return null;
  await connectToDatabase();
  const doc = await DepartmentModel.findOne({ _id: oid(departmentId) })
    .select({ storageUsedBytes: 1, storageQuotaBytes: 1 })
    .lean<{ storageUsedBytes: number; storageQuotaBytes: number }>()
    .exec();
  if (!doc) return null;
  return quotaState(doc.storageUsedBytes ?? 0, doc.storageQuotaBytes);
}

export async function recomputeAll(): Promise<RecomputeResult> {
  await connectToDatabase();

  const perFile = await FileVersionModel.aggregate<{ _id: Types.ObjectId; bytes: number }>([
    { $group: { _id: '$fileId', bytes: { $sum: '$fileSize' } } },
  ]).exec();
  const bytesByFile = new Map(perFile.map((row) => [String(row._id), row.bytes]));

  const files = await FileModel.find({})
    .setOptions({ withDeleted: true })
    .select({ ownerId: 1, departmentId: 1, projectId: 1 })
    .lean<
      Array<{
        _id: Types.ObjectId;
        ownerId: Types.ObjectId;
        departmentId: Types.ObjectId | null;
        projectId: Types.ObjectId | null;
      }>
    >()
    .exec();

  const byUser = new Map<string, number>();
  const byDepartment = new Map<string, number>();
  const byProject = new Map<string, number>();

  const add = (map: Map<string, number>, key: string | null | undefined, bytes: number) => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + bytes);
  };

  for (const file of files) {
    const bytes = bytesByFile.get(String(file._id)) ?? 0;
    add(byUser, String(file.ownerId), bytes);
    add(byDepartment, file.departmentId ? String(file.departmentId) : null, bytes);
    add(byProject, file.projectId ? String(file.projectId) : null, bytes);
  }

  await UserModel.updateMany({}, { $set: { storageUsedBytes: 0 } }).exec();
  await DepartmentModel.updateMany({}, { $set: { storageUsedBytes: 0 } }).exec();
  await ProjectModel.updateMany({}, { $set: { storageUsedBytes: 0 } }).exec();

  for (const [userId, bytes] of byUser) {
    await UserModel.updateOne(
      { _id: oid(userId) },
      { $set: { storageUsedBytes: Math.max(0, bytes) } },
    ).exec();
  }
  for (const [departmentId, bytes] of byDepartment) {
    await DepartmentModel.updateOne(
      { _id: oid(departmentId) },
      { $set: { storageUsedBytes: Math.max(0, bytes) } },
    ).exec();
  }
  for (const [projectId, bytes] of byProject) {
    await ProjectModel.updateOne(
      { _id: oid(projectId) },
      { $set: { storageUsedBytes: Math.max(0, bytes) } },
    ).exec();
  }

  return { users: byUser.size, departments: byDepartment.size, projects: byProject.size };
}

export const mongoStorageUsageRepository: StorageUsageRepository = {
  applyDelta,
  getUserQuota,
  getDepartmentQuota,
  recomputeAll,
};
