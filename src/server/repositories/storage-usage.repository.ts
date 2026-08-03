/**
 * Storage accounting.
 *
 * Usage counters live on the user, department and project documents rather than being
 * summed on demand: a quota check happens before every upload, and a `$group` over
 * every version to answer it would make uploading slower as the archive grows.
 *
 * They are therefore derived values that can drift, so `recomputeAll` exists and the
 * verification script runs it. The authority is always the sum of version sizes.
 */
import { Types, type ClientSession } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import {
  DepartmentModel,
  FileModel,
  FileVersionModel,
  ProjectModel,
  UserModel,
} from '@/server/db/models';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export interface UsageDelta {
  userId: string;
  departmentId?: string | null;
  projectId?: string | null;
  bytes: number;
}

/** Applies a signed delta to every counter an upload or deletion touches. */
export async function applyDelta(delta: UsageDelta, session?: ClientSession): Promise<void> {
  await connectToDatabase();
  const sessionOption = session ? { session } : {};

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

export interface QuotaState {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
}

export async function getUserQuota(userId: string): Promise<QuotaState | null> {
  await connectToDatabase();
  const doc = await UserModel.findOne({ _id: oid(userId) })
    .select({ storageUsedBytes: 1, storageQuotaBytes: 1 })
    .lean<{ storageUsedBytes: number; storageQuotaBytes: number }>()
    .exec();
  if (!doc) return null;
  return {
    usedBytes: doc.storageUsedBytes ?? 0,
    quotaBytes: doc.storageQuotaBytes,
    remainingBytes: Math.max(0, doc.storageQuotaBytes - (doc.storageUsedBytes ?? 0)),
  };
}

export async function getDepartmentQuota(departmentId: string): Promise<QuotaState | null> {
  await connectToDatabase();
  const doc = await DepartmentModel.findOne({ _id: oid(departmentId) })
    .select({ storageUsedBytes: 1, storageQuotaBytes: 1 })
    .lean<{ storageUsedBytes: number; storageQuotaBytes: number }>()
    .exec();
  if (!doc) return null;
  return {
    usedBytes: doc.storageUsedBytes ?? 0,
    quotaBytes: doc.storageQuotaBytes,
    remainingBytes: Math.max(0, doc.storageQuotaBytes - (doc.storageUsedBytes ?? 0)),
  };
}

/**
 * Rebuilds every counter from the versions that actually exist.
 *
 * Deliberately sums *versions*, not files: every version occupies disk, and a quota
 * that only counted current versions would let an unbounded version history fill a
 * volume while reporting plenty of room.
 */
export async function recomputeAll(): Promise<{ users: number; departments: number; projects: number }> {
  await connectToDatabase();

  const perFile = await FileVersionModel.aggregate<{ _id: Types.ObjectId; bytes: number }>([
    { $group: { _id: '$fileId', bytes: { $sum: '$fileSize' } } },
  ]).exec();
  const bytesByFile = new Map(perFile.map((row) => [String(row._id), row.bytes]));

  const files = await FileModel.find({})
    .setOptions({ withDeleted: true })
    .select({ ownerId: 1, departmentId: 1, projectId: 1 })
    .lean<Array<{ _id: Types.ObjectId; ownerId: Types.ObjectId; departmentId: Types.ObjectId | null; projectId: Types.ObjectId | null }>>()
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
    await UserModel.updateOne({ _id: oid(userId) }, { $set: { storageUsedBytes: bytes } }).exec();
  }
  for (const [departmentId, bytes] of byDepartment) {
    await DepartmentModel.updateOne(
      { _id: oid(departmentId) },
      { $set: { storageUsedBytes: bytes } },
    ).exec();
  }
  for (const [projectId, bytes] of byProject) {
    await ProjectModel.updateOne({ _id: oid(projectId) }, { $set: { storageUsedBytes: bytes } }).exec();
  }

  return { users: byUser.size, departments: byDepartment.size, projects: byProject.size };
}
