import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { ActivityModel, type ActivityDocument, type ActivityEntityType } from '@/server/db/models';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export interface ActivityRecord {
  id: string;
  actorUserId: string;
  actorName: string;
  action: string;
  entityType: ActivityEntityType;
  entityId: string;
  entityLabel: string;
  detail: unknown;
  createdAt: Date;
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

export interface AppendActivityInput {
  organizationId: string;
  actorUserId: string;
  actorName: string;
  action: string;
  entityType: ActivityEntityType;
  entityId: string;
  entityLabel?: string;
  contextFolderIds?: string[];
  departmentId?: string | null;
  projectId?: string | null;
  detail?: unknown;
}

export async function append(
  input: AppendActivityInput,
  session?: ClientSession,
): Promise<void> {
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
    session ? { session } : undefined,
  );
}

/** Timeline for one entity, newest first. */
export async function listForEntity(
  entityType: ActivityEntityType,
  entityId: string,
  limit = 50,
): Promise<ActivityRecord[]> {
  await connectToDatabase();
  const docs = await ActivityModel.find({ entityType, entityId: oid(entityId) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<LeanActivity[]>()
    .exec();
  return docs.map(toRecord);
}

/** Timeline for a folder including everything that happened inside its subtree. */
export async function listForFolderTree(
  folderId: string,
  limit = 50,
): Promise<ActivityRecord[]> {
  await connectToDatabase();
  const folderOid = oid(folderId);
  const filter: FilterQuery<ActivityDocument> = {
    $or: [
      { entityType: 'folder', entityId: folderOid },
      { contextFolderIds: folderOid },
    ],
  };
  const docs = await ActivityModel.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<LeanActivity[]>()
    .exec();
  return docs.map(toRecord);
}

/**
 * Timeline for a project.
 *
 * Activity rows carry a label but never file content, and the caller has already been
 * checked against the project itself — so this is a record of *what happened here*, not
 * a second route to files a viewer could not otherwise open.
 */
export async function listForProject(
  projectId: string,
  limit = 30,
): Promise<ActivityRecord[]> {
  if (!Types.ObjectId.isValid(projectId)) return [];
  await connectToDatabase();
  const docs = await ActivityModel.find({ projectId: oid(projectId) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<LeanActivity[]>()
    .exec();
  return docs.map(toRecord);
}
