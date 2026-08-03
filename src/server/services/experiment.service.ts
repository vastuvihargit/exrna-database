/**
 * Experiments — the research anchor files are traced back to.
 *
 * Access is derived, never separate. An experiment has no ACL of its own: whoever can
 * see the project can see its experiments, and whoever may edit research metadata in
 * that project may record them. A second, independent permission surface here would be
 * a second thing to get wrong, and an experiment discloses far less than the files
 * hanging off it.
 *
 * One consequence is deliberate and worth stating: an experiment's *file count* is not
 * permission-filtered — it counts every file linked to it. Listing those files goes
 * through the file layer, which filters normally, so a colleague may see "14 files" and
 * be able to open nine of them. Counting is a property of the experiment; reading is a
 * property of the file.
 */
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/server/errors/app-error';
import { sanitizeDisplayName } from '@/server/domain/naming';
import type { Permission } from '@/server/domain/permissions';
import type { Actor } from '@/server/permissions/actor';
import { auditService } from '@/server/audit/audit.service';
import * as experimentRepository from '@/server/repositories/experiment.repository';
import type { ExperimentRecord } from '@/server/repositories/experiment.repository';
import * as fileRepository from '@/server/repositories/file.repository';
import * as folderRepository from '@/server/repositories/folder.repository';
import type { ProjectRecord } from '@/server/repositories/project.repository';
import type { RequestMeta } from '@/server/http/request-meta';
import type { ExperimentOutcome, ExperimentStatus } from '@/server/db/models';
import { projectService } from './project.service';
import { projectCan } from './project-access';

export interface ExperimentView extends ExperimentRecord {
  projectCode: string;
  projectName: string;
  capabilities: { edit: boolean; delete: boolean };
}

function assertProjectPermission(
  actor: Actor,
  project: ProjectRecord,
  permission: Permission,
  message: string,
): void {
  if (!projectCan(actor, permission, project)) throw new ForbiddenError(message);
}

/* ------------------------------------------------------------------ reads */

export interface ListExperimentsInput {
  projectId?: string;
  status?: ExperimentStatus;
  q?: string;
  sampleId?: string;
  page: number;
  pageSize: number;
}

export async function list(
  actor: Actor,
  input: ListExperimentsInput,
): Promise<{ items: ExperimentView[]; total: number }> {
  // The visible-project set is resolved first and the query is confined to it, so an
  // experiment in a project the actor cannot reach is never fetched — its code and title
  // would otherwise disclose research they are not cleared for.
  const projects = input.projectId
    ? [await projectService.getById(actor, input.projectId)]
    : await projectService.list(actor);

  const byId = new Map(projects.map((project) => [project.id, project]));

  const { items, total } = await experimentRepository.list({
    organizationId: actor.organizationId,
    projectIds: [...byId.keys()],
    ...(input.status ? { status: input.status } : {}),
    ...(input.q ? { text: input.q } : {}),
    ...(input.sampleId ? { sampleId: input.sampleId } : {}),
    page: input.page,
    pageSize: input.pageSize,
  });

  return { items: items.map((item) => toView(actor, item, byId.get(item.projectId))), total };
}

export async function getById(actor: Actor, experimentId: string): Promise<ExperimentView> {
  const experiment = await experimentRepository.findById(experimentId);
  if (!experiment || experiment.organizationId !== actor.organizationId) throw new NotFoundError();

  // Throws NotFound when the project is invisible, which is the right answer for the
  // experiment too — a 403 here would confirm the id exists.
  const project = await projectService.getById(actor, experiment.projectId);
  return toView(actor, experiment, project);
}

/* ---------------------------------------------------------------- mutate */

export interface CreateExperimentInput {
  projectId: string;
  code: string;
  title: string;
  objective?: string;
  status?: ExperimentStatus;
  outcome?: ExperimentOutcome;
  outcomeSummary?: string;
  leadUserId?: string | null;
  collaboratorUserIds?: string[];
  protocolRef?: string;
  instrumentRef?: string;
  organism?: string;
  sampleIds?: string[];
  startedOn?: Date | null;
  completedOn?: Date | null;
  folderId?: string | null;
  tags?: string[];
}

export async function create(
  actor: Actor,
  input: CreateExperimentInput,
  meta: RequestMeta,
): Promise<ExperimentView> {
  const project = await projectService.getById(actor, input.projectId);
  assertProjectPermission(
    actor,
    project,
    'metadata.edit',
    'You cannot record experiments in this project',
  );

  const code = input.code.trim().toUpperCase();
  if (await experimentRepository.findByCode(actor.organizationId, code)) {
    throw new ConflictError(`An experiment with the code "${code}" already exists`);
  }

  const title = sanitizeDisplayName(input.title);
  if (!title) throw new ValidationError('Enter an experiment title');

  const folderId = await validFolderId(actor, project, input.folderId ?? null);

  const experiment = await experimentRepository.create({
    organizationId: actor.organizationId,
    projectId: project.id,
    departmentId: project.departmentId,
    code,
    title,
    ...(input.objective !== undefined ? { objective: input.objective } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    leadUserId: input.leadUserId ?? project.leadUserId,
    collaboratorUserIds: validCollaborators(project, input.collaboratorUserIds ?? []),
    ...(input.protocolRef !== undefined ? { protocolRef: input.protocolRef.trim() } : {}),
    ...(input.instrumentRef !== undefined ? { instrumentRef: input.instrumentRef.trim() } : {}),
    ...(input.organism !== undefined ? { organism: input.organism.trim() } : {}),
    sampleIds: normalizeSampleIds(input.sampleIds ?? []),
    startedOn: input.startedOn ?? null,
    completedOn: input.completedOn ?? null,
    folderId,
    // Experiments are classified with their project. Nothing more sensitive can be
    // recorded here than the drive it describes.
    confidentiality: project.confidentiality,
    tags: normalizeTags(input.tags ?? []),
    createdBy: actor.userId,
  });

  await auditService.recordForActor(actor, meta, {
    action: 'settings.updated',
    entityType: 'experiment',
    entityId: experiment.id,
    entityLabel: `${experiment.code} — ${experiment.title}`,
    newValue: { projectId: project.id, code: experiment.code, title: experiment.title },
    severity: 'notice',
  });

  return toView(actor, experiment, project);
}

export interface UpdateExperimentInput {
  title?: string;
  objective?: string;
  status?: ExperimentStatus;
  outcome?: ExperimentOutcome;
  outcomeSummary?: string;
  leadUserId?: string | null;
  collaboratorUserIds?: string[];
  protocolRef?: string;
  instrumentRef?: string;
  organism?: string;
  sampleIds?: string[];
  startedOn?: Date | null;
  completedOn?: Date | null;
  folderId?: string | null;
  tags?: string[];
}

export async function update(
  actor: Actor,
  experimentId: string,
  input: UpdateExperimentInput,
  meta: RequestMeta,
): Promise<ExperimentView> {
  const current = await getById(actor, experimentId);
  const project = await projectService.getById(actor, current.projectId);
  assertProjectPermission(actor, project, 'metadata.edit', 'You cannot change this experiment');

  const update: Record<string, unknown> = { updatedBy: actor.userId };

  if (input.title !== undefined) {
    const title = sanitizeDisplayName(input.title);
    if (!title) throw new ValidationError('Enter an experiment title');
    update.title = title;
  }
  if (input.objective !== undefined) update.objective = input.objective;
  if (input.outcomeSummary !== undefined) update.outcomeSummary = input.outcomeSummary;
  if (input.outcome !== undefined) update.outcome = input.outcome;
  if (input.status !== undefined) {
    update.status = input.status;
    // Completion stamps itself so a dashboard cannot show a completed experiment with no
    // end date, but an explicitly supplied date still wins.
    if (input.status === 'completed' && input.completedOn === undefined && !current.completedOn) {
      update.completedOn = new Date();
    }
  }
  if (input.leadUserId !== undefined) update.leadUserId = input.leadUserId;
  if (input.collaboratorUserIds !== undefined) {
    update.collaboratorUserIds = validCollaborators(project, input.collaboratorUserIds);
  }
  if (input.protocolRef !== undefined) update.protocolRef = input.protocolRef.trim();
  if (input.instrumentRef !== undefined) update.instrumentRef = input.instrumentRef.trim();
  if (input.organism !== undefined) update.organism = input.organism.trim();
  if (input.sampleIds !== undefined) update.sampleIds = normalizeSampleIds(input.sampleIds);
  if (input.startedOn !== undefined) update.startedOn = input.startedOn;
  if (input.completedOn !== undefined) update.completedOn = input.completedOn;
  if (input.tags !== undefined) update.tags = normalizeTags(input.tags);
  if (input.folderId !== undefined) {
    update.folderId = await validFolderId(actor, project, input.folderId);
  }

  const updated = await experimentRepository.updateById(experimentId, { $set: update });
  if (!updated) throw new NotFoundError();

  await auditService.recordForActor(actor, meta, {
    action: 'settings.updated',
    entityType: 'experiment',
    entityId: experimentId,
    entityLabel: `${updated.code} — ${updated.title}`,
    previousValue: { status: current.status, outcome: current.outcome, title: current.title },
    newValue: update,
  });

  return toView(actor, updated, project);
}

/**
 * Archives an experiment.
 *
 * Files keep pointing at it. Unlinking them would silently erase the provenance of data
 * that has already been reported — the opposite of what an experiment record is for — so
 * an archived experiment stays readable and its files stay traceable.
 */
export async function archive(
  actor: Actor,
  experimentId: string,
  meta: RequestMeta,
): Promise<void> {
  const current = await getById(actor, experimentId);
  const project = await projectService.getById(actor, current.projectId);
  assertProjectPermission(actor, project, 'resource.delete', 'You cannot remove this experiment');

  await experimentRepository.softDelete(experimentId, actor.userId);

  await auditService.recordForActor(actor, meta, {
    action: 'resource.archive',
    entityType: 'experiment',
    entityId: experimentId,
    entityLabel: `${current.code} — ${current.title}`,
    newValue: { linkedFiles: current.fileCount },
    severity: 'warning',
  });
}

/**
 * Resolves an experiment a file is being linked to, or throws.
 *
 * Called by the file service. Returns the record so the caller can copy the project id
 * across without a second read.
 */
export async function resolveForLinking(
  actor: Actor,
  experimentId: string,
): Promise<ExperimentRecord> {
  const experiment = await experimentRepository.findById(experimentId);
  if (!experiment || experiment.organizationId !== actor.organizationId) throw new NotFoundError();

  const project = await projectService.getById(actor, experiment.projectId);
  assertProjectPermission(
    actor,
    project,
    'metadata.edit',
    'You can only link files to experiments in projects you work on',
  );

  return experiment;
}

export async function adjustFileCount(experimentId: string, delta: number): Promise<void> {
  await experimentRepository.adjustFileCount(experimentId, delta);
}

/* --------------------------------------------------------------- helpers */

/**
 * A collaborator must already be on the project.
 *
 * Naming someone here does not grant them anything — the experiment has no ACL — but a
 * list of colleagues who are not on the project reads like an access list and would be
 * acted on as one.
 */
function validCollaborators(project: ProjectRecord, userIds: string[]): string[] {
  const allowed = new Set([...project.memberUserIds, ...(project.leadUserId ? [project.leadUserId] : [])]);
  const invalid = userIds.filter((id) => !allowed.has(id));
  if (invalid.length > 0) {
    throw new ValidationError('Collaborators must be members of the project');
  }
  return [...new Set(userIds)];
}

async function validFolderId(
  actor: Actor,
  project: ProjectRecord,
  folderId: string | null,
): Promise<string | null> {
  if (!folderId) return null;
  const folder = await folderRepository.findById(folderId);
  if (!folder || folder.organizationId !== actor.organizationId) throw new NotFoundError();
  // Pointing an experiment at a folder in another drive would put a research link across
  // a boundary the permission layer would then have to reason about. It cannot happen.
  if (folder.projectId !== project.id) {
    throw new ValidationError('The experiment folder must be inside the project drive');
  }
  return folder.id;
}

function normalizeSampleIds(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value || value.length > 60) continue;
    const key = value.toLowerCase();
    if (!seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()].slice(0, 200);
}

function normalizeTags(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value || value.length > 40) continue;
    const key = value.toLowerCase();
    if (!seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()].slice(0, 25);
}

function toView(
  actor: Actor,
  experiment: ExperimentRecord,
  project: ProjectRecord | undefined,
): ExperimentView {
  return {
    ...experiment,
    projectCode: project?.code ?? '',
    projectName: project?.name ?? '',
    capabilities: {
      edit: project ? projectCan(actor, 'metadata.edit', project) : false,
      delete: project ? projectCan(actor, 'resource.delete', project) : false,
    },
  };
}

/** Exported so the project dashboard can shape experiments the same way this service does. */
export function viewFor(
  actor: Actor,
  experiment: ExperimentRecord,
  project: ProjectRecord,
): ExperimentView {
  return toView(actor, experiment, project);
}

/** Files linked to an experiment, permission-filtered by the caller's own visibility. */
export async function countFiles(experimentId: string): Promise<number> {
  return fileRepository.countForExperiment(experimentId);
}

export const experimentService = {
  list,
  getById,
  create,
  update,
  archive,
  resolveForLinking,
  adjustFileCount,
  countFiles,
};
