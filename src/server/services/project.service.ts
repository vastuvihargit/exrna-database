/**
 * Research projects.
 *
 * Creating a project also creates its drive and the standard folder template, in one
 * transaction: a project whose drive failed to materialize would send its team back to
 * inventing their own folder names, which is the problem the template exists to solve.
 */
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/server/errors/app-error';
import { sanitizeDisplayName } from '@/server/domain/naming';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type { Actor } from '@/server/permissions/actor';
import { visibleProjectsInput } from '@/server/permissions/project-visibility';
import { auditService } from '@/server/audit/audit.service';
import * as activityRepository from '@/server/repositories/activity.repository';
import type { ActivityRecord } from '@/server/repositories/activity.repository';
import * as departmentRepository from '@/server/repositories/department.repository';
import * as experimentRepository from '@/server/repositories/experiment.repository';
import * as fileRepository from '@/server/repositories/file.repository';
import * as folderRepository from '@/server/repositories/folder.repository';
import * as projectRepository from '@/server/repositories/project.repository';
import * as userRepository from '@/server/repositories/user.repository';
import type { ProjectRecord } from '@/server/repositories/project.repository';
import type { RequestMeta } from '@/server/http/request-meta';
import { projectRootKey } from './drive.service';
import { projectCan } from './project-access';
import { templateService } from './template.service';
// Type-only: the value side of experiment.service imports this module, and importing it
// back would be a cycle. `import type` is erased, so this one is not.
import type { ExperimentView } from './experiment.service';

export async function list(actor: Actor): Promise<ProjectRecord[]> {
  return projectRepository.listVisible(visibleProjectsInput(actor));
}

export async function getById(actor: Actor, projectId: string): Promise<ProjectRecord> {
  const project = await projectRepository.findById(projectId);
  if (!project || project.organizationId !== actor.organizationId) throw new NotFoundError();

  const visible = await list(actor);
  if (!visible.some((candidate) => candidate.id === project.id)) throw new NotFoundError();
  return project;
}

export interface CreateProjectInput {
  name: string;
  code: string;
  departmentId: string;
  description?: string;
  leadUserId?: string | null;
  memberUserIds?: string[];
  confidentiality?: ConfidentialityLevel;
  startDate?: Date;
  targetEndDate?: Date;
  tags?: string[];
}

export async function create(
  actor: Actor,
  input: CreateProjectInput,
  meta: RequestMeta,
): Promise<ProjectRecord> {
  assertCanManageProjects(actor, input.departmentId);

  const department = await departmentRepository.findById(input.departmentId);
  if (!department || department.organizationId !== actor.organizationId) {
    throw new ValidationError('Unknown department');
  }

  const code = input.code.trim().toUpperCase();
  if (await projectRepository.findByCode(actor.organizationId, code)) {
    throw new ConflictError('A project with this code already exists');
  }

  const name = sanitizeDisplayName(input.name);
  if (!name) throw new ValidationError('Enter a project name');

  const members = await validMembers(actor, input.memberUserIds ?? [], input.leadUserId ?? null);
  const confidentiality = input.confidentiality ?? 'internal';

  // The project row and its membership are written atomically by the repository — a Mongo
  // session there, a D1 batch in the other implementation. D1 has no interactive transaction,
  // so a session cannot cross the repository boundary; see project.repository.contract.ts.
  const project = await projectRepository.create({
    organizationId: actor.organizationId,
    departmentId: input.departmentId,
    name,
    code,
    ...(input.description !== undefined ? { description: input.description } : {}),
    leadUserId: input.leadUserId ?? null,
    memberUserIds: members,
    confidentiality,
    startDate: input.startDate ?? null,
    targetEndDate: input.targetEndDate ?? null,
    tags: input.tags ?? [],
    createdBy: actor.userId,
  });

  // The drive is built outside the transaction so a slow template build cannot hold a
  // write lock; a project without its drive is repaired on next open by ensureRoot.
  const root = await folderRepository.ensureRoot({
    rootKey: projectRootKey(project.id),
    organizationId: actor.organizationId,
    name: project.name,
    driveType: 'project',
    ownerId: project.leadUserId ?? actor.userId,
    departmentId: project.departmentId,
    projectId: project.id,
    confidentiality,
    createdBy: actor.userId,
  });

  await applyTemplate(actor, root.id, confidentiality);
  await projectRepository.updateById(project.id, { rootFolderId: root.id });

  await auditService.recordForActor(actor, meta, {
    action: 'settings.updated',
    entityType: 'project',
    entityId: project.id,
    entityLabel: `${project.code} — ${project.name}`,
    newValue: { name: project.name, code: project.code, departmentId: project.departmentId },
    severity: 'notice',
  });

  return { ...project, rootFolderId: root.id };
}

/**
 * Creates the project folder template inside a fresh drive root.
 *
 * The work itself lives in `template.service`, which both this and the department drive
 * build from — administrators edit one template set, not two implementations of it.
 */
export async function applyTemplate(
  actor: Actor,
  rootFolderId: string,
  confidentiality: ConfidentialityLevel,
): Promise<number> {
  return templateService.applyFolderTemplate({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    rootFolderId,
    kind: 'project',
    confidentiality,
  });
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  leadUserId?: string | null;
  memberUserIds?: string[];
  status?: 'planning' | 'active' | 'on_hold' | 'completed' | 'archived';
  confidentiality?: ConfidentialityLevel;
  targetEndDate?: Date | null;
  tags?: string[];
}

export async function update(
  actor: Actor,
  projectId: string,
  input: UpdateProjectInput,
  meta: RequestMeta,
): Promise<ProjectRecord> {
  const project = await getById(actor, projectId);
  assertCanManageProjects(actor, project.departmentId);

  const update: projectRepository.ProjectPatch = {};
  if (input.name !== undefined) update.name = sanitizeDisplayName(input.name);
  if (input.description !== undefined) update.description = input.description;
  if (input.leadUserId !== undefined) update.leadUserId = input.leadUserId;
  if (input.status !== undefined) {
    update.status = input.status;
    update.completedAt = input.status === 'completed' ? new Date() : null;
  }
  if (input.confidentiality !== undefined) update.confidentiality = input.confidentiality;
  if (input.targetEndDate !== undefined) update.targetEndDate = input.targetEndDate;
  if (input.tags !== undefined) update.tags = input.tags;

  let members: string[] | null = null;
  if (input.memberUserIds !== undefined) {
    members = await validMembers(actor, input.memberUserIds, input.leadUserId ?? project.leadUserId);
    update.memberUserIds = members;
  }

  // Row and membership land together, or neither does — see the note in `create` above.
  const updated = await projectRepository.updateById(projectId, update);
  if (!updated) throw new NotFoundError();

  await auditService.recordForActor(actor, meta, {
    action: 'settings.updated',
    entityType: 'project',
    entityId: projectId,
    entityLabel: `${updated.code} — ${updated.name}`,
    previousValue: {
      name: project.name,
      status: project.status,
      memberCount: project.memberUserIds.length,
    },
    newValue: update,
  });

  return updated;
}

async function validMembers(
  actor: Actor,
  memberUserIds: string[],
  leadUserId: string | null,
): Promise<string[]> {
  const unique = [...new Set([...memberUserIds, ...(leadUserId ? [leadUserId] : [])])];
  if (unique.length === 0) return [];

  const users = await Promise.all(unique.map((id) => userRepository.findById(id)));
  const valid: string[] = [];
  for (const [index, user] of users.entries()) {
    const id = unique[index]!;
    // Cross-organization membership would grant access across a tenant boundary.
    if (!user || user.organizationId !== actor.organizationId) {
      throw new ValidationError('One of the selected employees does not exist');
    }
    valid.push(id);
  }
  return valid;
}

/**
 * Creating and editing a project drive is a management action: it hands a group of
 * people a shared space and a confidentiality level.
 */
function assertCanManageProjects(actor: Actor, departmentId: string): void {
  if (actor.isSuperAdmin) return;
  const allowed = actor.grants.some(
    (grant) =>
      grant.permissions.includes('access.manage') &&
      (grant.scopeType === 'company' ||
        (grant.scopeType === 'department' && grant.scopeId === departmentId)),
  );
  if (!allowed) throw new ForbiddenError('You cannot create or change project drives');
}

/* ---------------------------------------------------------- dashboard */

export interface ProjectOverview {
  project: ProjectRecord;
  department: { id: string; name: string; code: string } | null;
  members: Array<{ id: string; name: string; email: string; isLead: boolean }>;
  content: fileRepository.ProjectContentBreakdown;
  experiments: { total: number; byStatus: Record<string, number> };
  recentExperiments: ExperimentView[];
  activity: ActivityRecord[];
  /** Template folders that are missing from the drive root, so the gap is visible. */
  missingTemplateFolders: Array<{ key: string; name: string }>;
}

/**
 * Everything the project dashboard shows, in one call.
 *
 * Every count comes from the caller's own visibility filter, so two people can open the
 * same dashboard and legitimately see different totals. The alternative — one true
 * number for everyone — would tell a viewer exactly how much of the project is hidden
 * from them, which is the disclosure the confidentiality levels exist to prevent.
 */
export async function overview(actor: Actor, projectId: string): Promise<ProjectOverview> {
  const project = await getById(actor, projectId);

  const [department, memberRecords, content, experimentCounts, recentExperiments, activity] =
    await Promise.all([
      departmentRepository.findById(project.departmentId),
      userRepository.findByIds(
        [...new Set([...project.memberUserIds, ...(project.leadUserId ? [project.leadUserId] : [])])],
      ),
      fileRepository.projectContentBreakdown(actor, project.id),
      experimentRepository.countByStatusForProject(project.id),
      experimentRepository.listForProject(project.id, 8),
      activityRepository.listForProject(project.id, 20),
    ]);

  const missingTemplateFolders = project.rootFolderId
    ? await templateService.missingTemplateFolders({
        organizationId: actor.organizationId,
        rootFolderId: project.rootFolderId,
        kind: 'project',
      })
    : [];

  // One decision for the whole list: an experiment has no ACL of its own, so every
  // experiment in a project answers the same permission question.
  const experimentCapabilities = {
    edit: projectCan(actor, 'metadata.edit', project),
    delete: projectCan(actor, 'resource.delete', project),
  };

  return {
    project,
    department: department
      ? { id: department.id, name: department.name, code: department.code }
      : null,
    members: memberRecords.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      isLead: user.id === project.leadUserId,
    })),
    content,
    experiments: {
      total: Object.values(experimentCounts).reduce((sum, count) => sum + count, 0),
      byStatus: experimentCounts,
    },
    recentExperiments: recentExperiments.map((experiment) => ({
      ...experiment,
      projectCode: project.code,
      projectName: project.name,
      capabilities: experimentCapabilities,
    })),
    activity,
    missingTemplateFolders,
  };
}

export const projectService = { list, getById, create, update, applyTemplate, overview };
