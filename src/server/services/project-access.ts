/**
 * A project, expressed as something the permission layer can answer questions about.
 *
 * Shared by the project and experiment services so both ask the same question the same
 * way. It sits in its own module for the ordinary reason: `experiment.service` needs the
 * project's position in the permission graph and `project.service` needs experiments,
 * and a helper owned by either one would make that a cycle.
 */
import type { Permission } from '@/server/domain/permissions';
import type { Actor, ResourceRef } from '@/server/permissions/actor';
import { can } from '@/server/permissions/authorize';
import type { ProjectRecord } from '@/server/repositories/project.repository';

export function projectResource(project: ProjectRecord): ResourceRef {
  return {
    type: 'project',
    id: project.id,
    organizationId: project.organizationId,
    departmentId: project.departmentId,
    projectId: project.id,
    // The lead administers the project's research records the way an owner does; without
    // this a project lead with no company-scoped role could not record an experiment in
    // their own project.
    ownerId: project.leadUserId,
    confidentiality: project.confidentiality,
  };
}

export function projectCan(
  actor: Actor,
  permission: Permission,
  project: ProjectRecord,
): boolean {
  return can(actor, permission, projectResource(project));
}
