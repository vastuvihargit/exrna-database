/**
 * The MongoDB experiment repository — the implementation that serves production today.
 *
 * Query logic unchanged. The `ClientSession` parameters are gone (no caller passed one) and
 * the raw `$set` update object is now a typed patch.
 */
import { Types, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import {
  ExperimentModel,
  type ExperimentDocument,
  type ExperimentOutcome,
  type ExperimentStatus,
} from '@/server/db/models';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type {
  CreateExperimentInput,
  ExperimentPatch,
  ExperimentRecord,
  ExperimentRepository,
  ListExperimentsInput,
} from './experiment.repository.contract';

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

function maybeOid(value: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : null;
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
  const _id = maybeOid(id);
  if (!_id) return null;
  await connectToDatabase();
  const doc = await ExperimentModel.findOne({ _id }).lean<LeanExperiment>().exec();
  return doc ? toRecord(doc) : null;
}

export async function findByIds(ids: string[]): Promise<ExperimentRecord[]> {
  const valid = ids.map(maybeOid).filter((id): id is Types.ObjectId => id !== null);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await ExperimentModel.find({ _id: { $in: valid } })
    .lean<LeanExperiment[]>()
    .exec();
  return docs.map(toRecord);
}

export async function findByCode(
  organizationId: string,
  code: string,
): Promise<ExperimentRecord | null> {
  const orgId = maybeOid(organizationId);
  if (!orgId) return null;
  await connectToDatabase();
  const doc = await ExperimentModel.findOne({ organizationId: orgId, code: code.toUpperCase() })
    .lean<LeanExperiment>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function list(
  input: ListExperimentsInput,
): Promise<{ items: ExperimentRecord[]; total: number }> {
  await connectToDatabase();

  const organizationId = maybeOid(input.organizationId);
  if (!organizationId) return { items: [], total: 0 };

  const projectIds = input.projectIds
    .map(maybeOid)
    .filter((id): id is Types.ObjectId => id !== null);
  // An empty visible-project set means "nothing", never "everything".
  if (projectIds.length === 0) return { items: [], total: 0 };

  const filter: FilterQuery<ExperimentDocument> = {
    organizationId,
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

export async function listForProject(
  projectId: string,
  limit = 200,
): Promise<ExperimentRecord[]> {
  const _projectId = maybeOid(projectId);
  if (!_projectId) return [];
  await connectToDatabase();
  const docs = await ExperimentModel.find({ projectId: _projectId })
    .sort({ code: 1 })
    .limit(limit)
    .lean<LeanExperiment[]>()
    .exec();
  return docs.map(toRecord);
}

export async function create(input: CreateExperimentInput): Promise<ExperimentRecord> {
  await connectToDatabase();
  const [doc] = await ExperimentModel.create([
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
  ]);
  return toRecord(doc!.toObject() as LeanExperiment);
}

const ID_FIELDS = new Set(['leadUserId', 'folderId', 'departmentId', 'updatedBy']);

function toSet(patch: ExperimentPatch): Record<string, unknown> {
  const $set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (ID_FIELDS.has(key)) {
      $set[key] = value === null ? null : oid(value as string);
    } else if (key === 'collaboratorUserIds') {
      $set[key] = (value as string[]).map(oid);
    } else {
      $set[key] = value;
    }
  }
  return $set;
}

export async function updateById(
  id: string,
  patch: ExperimentPatch,
): Promise<ExperimentRecord | null> {
  const _id = maybeOid(id);
  if (!_id) return null;

  const $set = toSet(patch);
  if (Object.keys($set).length === 0) return findById(id);

  await connectToDatabase();
  const doc = await ExperimentModel.findOneAndUpdate({ _id }, { $set }, { new: true })
    .lean<LeanExperiment>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function adjustFileCount(id: string, delta: number): Promise<void> {
  const _id = maybeOid(id);
  if (!_id || delta === 0) return;
  await connectToDatabase();
  await ExperimentModel.updateOne({ _id }, { $inc: { fileCount: delta } }).exec();
}

export async function softDelete(id: string, deletedBy: string): Promise<boolean> {
  const _id = maybeOid(id);
  if (!_id) return false;
  await connectToDatabase();
  const result = await ExperimentModel.updateOne(
    { _id },
    { $set: { deletedAt: new Date(), deletedBy: oid(deletedBy), status: 'archived' } },
  ).exec();
  return result.modifiedCount > 0;
}

/** Per-status counts for one project, for the project dashboard. */
export async function countByStatusForProject(
  projectId: string,
): Promise<Record<string, number>> {
  const _projectId = maybeOid(projectId);
  if (!_projectId) return {};
  await connectToDatabase();
  // An aggregate bypasses the soft-delete pre-hook, so the filter is written out here.
  const rows = await ExperimentModel.aggregate<{ _id: string; count: number }>([
    { $match: { projectId: _projectId, deletedAt: null } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).exec();

  const out: Record<string, number> = {};
  for (const row of rows) out[row._id] = row.count;
  return out;
}

export const mongoExperimentRepository: ExperimentRepository = {
  findById,
  findByIds,
  findByCode,
  list,
  listForProject,
  create,
  updateById,
  adjustFileCount,
  softDelete,
  countByStatusForProject,
};
