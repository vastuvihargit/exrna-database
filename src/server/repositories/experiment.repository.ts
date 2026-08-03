import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import {
  ExperimentModel,
  type ExperimentDocument,
  type ExperimentOutcome,
  type ExperimentStatus,
} from '@/server/db/models';
import type { ConfidentialityLevel } from '@/server/domain/permissions';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export interface ExperimentRecord {
  id: string;
  organizationId: string;
  projectId: string;
  departmentId: string | null;
  code: string;
  title: string;
  objective: string;
  status: ExperimentStatus;
  outcome: ExperimentOutcome;
  outcomeSummary: string;
  leadUserId: string | null;
  collaboratorUserIds: string[];
  protocolRef: string;
  instrumentRef: string;
  organism: string;
  sampleIds: string[];
  startedOn: Date | null;
  completedOn: Date | null;
  folderId: string | null;
  confidentiality: ConfidentialityLevel;
  tags: string[];
  fileCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

type LeanExperiment = ExperimentDocument & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(doc: LeanExperiment): ExperimentRecord {
  return {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    projectId: String(doc.projectId),
    departmentId: doc.departmentId ? String(doc.departmentId) : null,
    code: doc.code,
    title: doc.title,
    objective: doc.objective ?? '',
    status: doc.status as ExperimentStatus,
    outcome: doc.outcome as ExperimentOutcome,
    outcomeSummary: doc.outcomeSummary ?? '',
    leadUserId: doc.leadUserId ? String(doc.leadUserId) : null,
    collaboratorUserIds: (doc.collaboratorUserIds ?? []).map(String),
    protocolRef: doc.protocolRef ?? '',
    instrumentRef: doc.instrumentRef ?? '',
    organism: doc.organism ?? '',
    sampleIds: doc.sampleIds ?? [],
    startedOn: doc.startedOn ?? null,
    completedOn: doc.completedOn ?? null,
    folderId: doc.folderId ? String(doc.folderId) : null,
    confidentiality: doc.confidentiality as ConfidentialityLevel,
    tags: doc.tags ?? [],
    fileCount: doc.fileCount ?? 0,
    createdBy: String(doc.createdBy),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function findById(id: string): Promise<ExperimentRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectToDatabase();
  const doc = await ExperimentModel.findOne({ _id: oid(id) }).lean<LeanExperiment>().exec();
  return doc ? toRecord(doc) : null;
}

export async function findByIds(ids: string[]): Promise<ExperimentRecord[]> {
  const valid = ids.filter((id) => Types.ObjectId.isValid(id)).map(oid);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await ExperimentModel.find({ _id: { $in: valid } }).lean<LeanExperiment[]>().exec();
  return docs.map(toRecord);
}

export async function findByCode(
  organizationId: string,
  code: string,
): Promise<ExperimentRecord | null> {
  await connectToDatabase();
  const doc = await ExperimentModel.findOne({
    organizationId: oid(organizationId),
    code: code.toUpperCase(),
  })
    .lean<LeanExperiment>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export interface ListExperimentsInput {
  organizationId: string;
  /** Restricted to these projects — the caller has already decided which it may see. */
  projectIds: string[];
  status?: ExperimentStatus;
  text?: string;
  sampleId?: string;
  page: number;
  pageSize: number;
}

export async function list(
  input: ListExperimentsInput,
): Promise<{ items: ExperimentRecord[]; total: number }> {
  await connectToDatabase();

  const projectIds = input.projectIds.filter((id) => Types.ObjectId.isValid(id)).map(oid);
  // An empty visible-project set means "nothing", never "everything".
  if (projectIds.length === 0) return { items: [], total: 0 };

  const filter: FilterQuery<ExperimentDocument> = {
    organizationId: oid(input.organizationId),
    projectId: { $in: projectIds },
  };
  if (input.status) filter.status = input.status;
  if (input.sampleId) filter.sampleIds = input.sampleId;
  if (input.text) filter.$text = { $search: input.text };

  const skip = (input.page - 1) * input.pageSize;
  const [docs, total] = await Promise.all([
    ExperimentModel.find(filter)
      .sort(input.text ? { score: { $meta: 'textScore' } } : { code: 1 })
      .skip(skip)
      .limit(input.pageSize)
      .lean<LeanExperiment[]>()
      .exec(),
    ExperimentModel.countDocuments(filter).exec(),
  ]);

  return { items: docs.map(toRecord), total };
}

export async function listForProject(projectId: string, limit = 200): Promise<ExperimentRecord[]> {
  if (!Types.ObjectId.isValid(projectId)) return [];
  await connectToDatabase();
  const docs = await ExperimentModel.find({ projectId: oid(projectId) })
    .sort({ code: 1 })
    .limit(limit)
    .lean<LeanExperiment[]>()
    .exec();
  return docs.map(toRecord);
}

export interface CreateExperimentInput {
  organizationId: string;
  projectId: string;
  departmentId: string | null;
  code: string;
  title: string;
  objective?: string;
  status?: ExperimentStatus;
  outcome?: ExperimentOutcome;
  leadUserId?: string | null;
  collaboratorUserIds?: string[];
  protocolRef?: string;
  instrumentRef?: string;
  organism?: string;
  sampleIds?: string[];
  startedOn?: Date | null;
  completedOn?: Date | null;
  folderId?: string | null;
  confidentiality: ConfidentialityLevel;
  tags?: string[];
  createdBy: string;
}

export async function create(
  input: CreateExperimentInput,
  session?: ClientSession,
): Promise<ExperimentRecord> {
  await connectToDatabase();
  const [doc] = await ExperimentModel.create(
    [
      {
        organizationId: oid(input.organizationId),
        projectId: oid(input.projectId),
        departmentId: input.departmentId ? oid(input.departmentId) : null,
        code: input.code.toUpperCase(),
        title: input.title,
        objective: input.objective ?? '',
        status: input.status ?? 'planned',
        outcome: input.outcome ?? 'pending',
        leadUserId: input.leadUserId ? oid(input.leadUserId) : null,
        collaboratorUserIds: (input.collaboratorUserIds ?? []).map(oid),
        protocolRef: input.protocolRef ?? '',
        instrumentRef: input.instrumentRef ?? '',
        organism: input.organism ?? '',
        sampleIds: input.sampleIds ?? [],
        startedOn: input.startedOn ?? null,
        completedOn: input.completedOn ?? null,
        folderId: input.folderId ? oid(input.folderId) : null,
        confidentiality: input.confidentiality,
        tags: input.tags ?? [],
        createdBy: oid(input.createdBy),
      },
    ],
    session ? { session } : undefined,
  );
  return toRecord(doc!.toObject() as LeanExperiment);
}

export async function updateById(
  id: string,
  update: Record<string, unknown>,
  session?: ClientSession,
): Promise<ExperimentRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectToDatabase();
  const query = ExperimentModel.findOneAndUpdate({ _id: oid(id) }, update, { new: true });
  if (session) query.session(session);
  const doc = await query.lean<LeanExperiment>().exec();
  return doc ? toRecord(doc) : null;
}

export async function adjustFileCount(
  id: string,
  delta: number,
  session?: ClientSession,
): Promise<void> {
  if (!Types.ObjectId.isValid(id) || delta === 0) return;
  await connectToDatabase();
  await ExperimentModel.updateOne(
    { _id: oid(id) },
    { $inc: { fileCount: delta } },
    session ? { session } : {},
  ).exec();
}

export async function softDelete(id: string, deletedBy: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(id)) return false;
  await connectToDatabase();
  const result = await ExperimentModel.updateOne(
    { _id: oid(id) },
    { $set: { deletedAt: new Date(), deletedBy: oid(deletedBy), status: 'archived' } },
  ).exec();
  return result.modifiedCount > 0;
}

/** Per-status counts for one project, for the project dashboard. */
export async function countByStatusForProject(
  projectId: string,
): Promise<Record<string, number>> {
  if (!Types.ObjectId.isValid(projectId)) return {};
  await connectToDatabase();
  const rows = await ExperimentModel.aggregate<{ _id: string; count: number }>([
    { $match: { projectId: oid(projectId), deletedAt: null } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).exec();

  const out: Record<string, number> = {};
  for (const row of rows) out[row._id] = row.count;
  return out;
}
