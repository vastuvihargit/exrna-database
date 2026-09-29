/**
 * Drives — the three roots a user navigates from.
 *
 * My Drive is personal: its folders carry no department and no project, so no role
 * scope reaches into it and ownership is the only route in. Department and project
 * drives are the opposite: they carry the scope so the existing role grants apply
 * without any per-folder sharing.
 *
 * Roots are created on first access rather than up front — a company with 400
 * employees should not have 400 empty root folders before anyone signs in.
 */
import { ForbiddenError, NotFoundError } from '@/server/errors/app-error';
import type { Actor } from '@/server/permissions/actor';
import { actorHasCompanyWideRead } from '@/server/permissions/actor';
import { can } from '@/server/permissions/authorize';
import * as folderRepository from '@/server/repositories/folder.repository';
import type { FolderRecord } from '@/server/repositories/folder.repository';
import * as departmentRepository from '@/server/repositories/department.repository';
import * as projectRepository from '@/server/repositories/project.repository';
import { departmentVisibilityFilter } from '@/server/permissions/visibility';
import { canSeeProject, visibleProjectsInput } from '@/server/permissions/project-visibility';
import { templateService } from './template.service';

export function myDriveRootKey(userId: string): string {
  return `my:${userId}`;
}
export function departmentRootKey(departmentId: string): string {
  return `department:${departmentId}`;
}
export function projectRootKey(projectId: string): string {
  return `project:${projectId}`;
}

export async function getMyDriveRoot(actor: Actor): Promise<FolderRecord> {
  return folderRepository.ensureRoot({
    rootKey: myDriveRootKey(actor.userId),
    organizationId: actor.organizationId,
    name: 'My Drive',
    driveType: 'my',
    ownerId: actor.userId,
    // Deliberately null: this is what keeps a personal drive personal.
    departmentId: null,
    projectId: null,
    confidentiality: 'internal',
    createdBy: actor.userId,
  });
}

/**
 * Members of the department, and anyone with company-wide read, may open a department
 * drive. Everyone else gets 404 rather than 403 — the existence of a department drive
 * is not information a non-member needs.
 */
export async function getDepartmentRoot(
  actor: Actor,
  departmentId: string,
): Promise<FolderRecord> {
  const department = await departmentRepository.findById(departmentId);
  if (!department || department.organizationId !== actor.organizationId) throw new NotFoundError();

  const isMember = actor.departmentId === departmentId;
  const hasScopedGrant = actor.grants.some(
    (grant) =>
      grant.scopeType === 'company' ||
      (grant.scopeType === 'department' && grant.scopeId === departmentId),
  );
  if (!actor.isSuperAdmin && !actorHasCompanyWideRead(actor) && !isMember && !hasScopedGrant) {
    throw new NotFoundError();
  }

  const root = await folderRepository.ensureRoot({
    rootKey: departmentRootKey(departmentId),
    organizationId: actor.organizationId,
    name: department.name,
    driveType: 'department',
    // The head owns the drive where there is one; otherwise the administrator who
    // first opened it. `isSystem` still prevents either from renaming or deleting it.
    ownerId: department.headUserId ?? actor.userId,
    departmentId,
    projectId: null,
    confidentiality: 'internal',
    createdBy: actor.userId,
  });

  // The department template, applied on first open rather than at department creation:
  // roots themselves are created lazily, so there is no earlier moment at which the root
  // exists. Idempotent by name, and a failure here must not stop someone reaching their
  // drive — an empty department drive is usable, an error page is not.
  if (root.childFolderCount === 0) {
    await templateService
      .applyFolderTemplate({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        rootFolderId: root.id,
        kind: 'department',
        confidentiality: 'internal',
      })
      .catch(() => undefined);
    return (await folderRepository.findByIdInternal(root.id)) ?? root;
  }

  return root;
}

export async function getProjectRoot(actor: Actor, projectId: string): Promise<FolderRecord> {
  const project = await projectRepository.findById(projectId);
  if (!project || project.organizationId !== actor.organizationId) throw new NotFoundError();

  // Members always; everyone else by role scope *and* clearance, as the project list decides.
  if (!canSeeProject(actor, project)) throw new NotFoundError();

  const root = await folderRepository.ensureRoot({
    rootKey: projectRootKey(projectId),
    organizationId: actor.organizationId,
    name: project.name,
    driveType: 'project',
    ownerId: project.leadUserId ?? actor.userId,
    departmentId: project.departmentId,
    projectId,
    confidentiality: project.confidentiality,
    createdBy: actor.userId,
  });

  if (!project.rootFolderId) {
    await projectRepository.updateById(projectId, { rootFolderId: root.id });
  }
  return root;
}

export interface DriveSummary {
  id: string;
  kind: 'my' | 'department' | 'project';
  name: string;
  /** Null until the drive has been opened once and its root created. */
  rootFolderId: string | null;
  /** Present for department and project drives. */
  code?: string;
  departmentId?: string;
  href: string;
}

/**
 * The navigation payload: every drive this actor may open.
 *
 * Roots are not created here — listing your drives should not write to the database on
 * every page load. `rootFolderId` is null until the drive is actually opened.
 */
export async function listDrives(actor: Actor): Promise<{
  myDrive: DriveSummary;
  departments: DriveSummary[];
  projects: DriveSummary[];
}> {
  const [myRoot, departments, projects] = await Promise.all([
    folderRepository.findByRootKeyInternal(myDriveRootKey(actor.userId)),
    departmentRepository.list(departmentVisibilityFilter(actor)),
    listVisibleProjects(actor),
  ]);

  const companyWide = actor.isSuperAdmin || actorHasCompanyWideRead(actor);
  const accessibleDepartments = departments.filter((department) => {
    if (companyWide) return true;
    if (actor.departmentId === department.id) return true;
    return actor.grants.some(
      (grant) =>
        grant.scopeType === 'company' ||
        (grant.scopeType === 'department' && grant.scopeId === department.id),
    );
  });

  const rootKeys = [
    ...accessibleDepartments.map((d) => departmentRootKey(d.id)),
    ...projects.map((p) => projectRootKey(p.id)),
  ];
  const roots = await folderRepository.findByRootKeysInternal(rootKeys);
  const rootByKey = new Map(roots.map((root) => [root.rootKey, root.id]));

  return {
    myDrive: {
      id: actor.userId,
      kind: 'my',
      name: 'My Drive',
      rootFolderId: myRoot?.id ?? null,
      href: '/my-drive',
    },
    departments: accessibleDepartments.map((department) => ({
      id: department.id,
      kind: 'department' as const,
      name: department.name,
      code: department.code,
      rootFolderId: rootByKey.get(departmentRootKey(department.id)) ?? null,
      href: `/departments/${department.id}`,
    })),
    projects: projects.map((project) => ({
      id: project.id,
      kind: 'project' as const,
      name: project.name,
      code: project.code,
      departmentId: project.departmentId,
      rootFolderId: rootByKey.get(projectRootKey(project.id)) ?? null,
      href: `/projects/${project.id}`,
    })),
  };
}

export async function listVisibleProjects(actor: Actor) {
  return projectRepository.listVisible(visibleProjectsInput(actor));
}

/**
 * Resolves the root of the drive a folder belongs to. Used by "open containing drive"
 * and by the move dialog, which must not offer a destination in a drive the actor
 * cannot write to.
 */
export async function assertCanUseAsDestination(
  actor: Actor,
  destination: FolderRecord,
): Promise<void> {
  const allowed = can(
    actor,
    'folder.create',
    {
      type: 'folder',
      id: destination.id,
      organizationId: destination.organizationId,
      departmentId: destination.departmentId,
      projectId: destination.projectId,
      ownerId: destination.ownerId,
      confidentiality: destination.confidentiality,
      acl: destination.permissions,
      inheritPermissions: destination.inheritPermissions,
      status: destination.status,
      deletedAt: destination.deletedAt,
    },
    {},
  );
  if (!allowed) throw new ForbiddenError('You cannot add items to that folder');
}

export const driveService = {
  getMyDriveRoot,
  getDepartmentRoot,
  getProjectRoot,
  listDrives,
  listVisibleProjects,
};
