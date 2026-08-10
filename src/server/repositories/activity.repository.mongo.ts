/**
 * The MongoDB activity repository — the existing implementation, moved behind the contract.
 *
 * `deleteOlderThan` is new, because D1 has no TTL and the retention sweep has to exist on both
 * engines to mean anything.
 */
import { Types, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { ActivityModel, type ActivityDocument } from '@/server/db/models';
import {
  MAX_ACTIVITY_PAGE,
  type ActivityEntityType,
  type ActivityRecord,
  type ActivityRepository,
  type ActivityTx,
  type AppendActivityInput,
} from './activity.repository.contract';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

type LeanActivity = ActivityDocument & { _id: Types.ObjectId; createdAt: Date };

function toRecord(doc: LeanActivity): ActivityRecord {
  return {
    id: String(doc._id),
    actorUserId: String(doc.actorUserId),
    actorName: doc.actorName,
    action: doc.action,
    entityType: doc.entityType as ActivityEntityType,
    entityId: String(doc.entityId),
    entityLabel: doc.entityLabel ?? '',
    detail: doc.detail ?? null,
    createdAt: doc.createdAt,
  };
}

export async function append(input: AppendActivityInput, tx?: ActivityTx): Promise<void> {
  await connectToDatabase();
  await ActivityModel.create(
    [
      {
        organizationId: oid(input.organizationId),
        actorUserId: oid(input.actorUserId),
        actorName: input.actorName,
        action: input.action,
        entityType: input.entityType,
        entityId: oid(input.entityId),
        entityLabel: input.entityLabel ?? '',
        contextFolderIds: (input.contextFolderIds ?? []).map(oid),
        departmentId: input.departmentId ? oid(input.departmentId) : null,
        projectId: input.projectId ? oid(input.projectId) : null,
        detail: input.detail ?? null,
      },
    ],
    tx ? { session: tx } : undefined,
  );
}

export async function listForEntity(
  entityType: ActivityEntityType,
  entityId: string,
  limit = 50,
): Promise<ActivityRecord[]> {
  if (!Types.ObjectId.isValid(entityId)) return [];
  await connectToDatabase();
  const docs = await ActivityModel.find({ entityType, entityId: oid(entityId) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(limit, MAX_ACTIVITY_PAGE))
    .lean<LeanActivity[]>()
    .exec();
  return docs.map(toRecord);
}

export async function listForFolderTree(
  folderId: string,
  limit = 50,
): Promise<ActivityRecord[]> {
  if (!Types.ObjectId.isValid(folderId)) return [];
  await connectToDatabase();
  const folderOid = oid(folderId);
  const filter: FilterQuery<ActivityDocument> = {
    $or: [{ entityType: 'folder', entityId: folderOid }, { contextFolderIds: folderOid }],
  };
  const docs = await ActivityModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(limit, MAX_ACTIVITY_PAGE))
    .lean<LeanActivity[]>()
    .exec();
  return docs.map(toRecord);
}

export async function listForProject(
  projectId: string,
  limit = 30,
): Promise<ActivityRecord[]> {
  if (!Types.ObjectId.isValid(projectId)) return [];
  await connectToDatabase();
  const docs = await ActivityModel.find({ projectId: oid(projectId) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(limit, MAX_ACTIVITY_PAGE))
    .lean<LeanActivity[]>()
    .exec();
  return docs.map(toRecord);
}

export async function deleteOlderThan(cutoff: Date): Promise<number> {
  await connectToDatabase();
  const result = await ActivityModel.deleteMany({ createdAt: { $lt: cutoff } }).exec();
  return result.deletedCount ?? 0;
}

export const mongoActivityRepository: ActivityRepository = {
  append,
  listForEntity,
  listForFolderTree,
  listForProject,
  deleteOlderThan,
};
