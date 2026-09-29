/**
 * Who may see which projects — the one input both the project list and the drive landing page
 * hand to `projectRepository.listVisible`.
 *
 * Membership and leadership are explicit, per-person decisions and see a project at any
 * classification. Every *role-scope* route in — company-wide read, the actor's own department, a
 * department or project scope grant — also requires the project's classification to be within the
 * actor's clearance, exactly as `resourceVisibilityFilter` does for folders and files. Without
 * it, a Lab Technician (cleared to `internal`) with a department grant saw the name, members and
 * description of every `confidential` project in that department.
 */
import {
  CLEARANCE_BY_MAX_LEVEL,
  CONFIDENTIALITY_LEVELS,
  type ConfidentialityLevel,
} from '@/server/domain/permissions';
import type {
  ProjectRecord,
  VisibleProjectsInput,
} from '@/server/repositories/project.repository.contract';
import { actorClearance, actorHasCompanyWideRead, type Actor } from './actor';

function scopeIds(actor: Actor, scopeType: 'department' | 'project'): string[] {
  return actor.grants
    .filter((grant) => grant.scopeType === scopeType && grant.scopeId)
    .map((grant) => grant.scopeId as string);
}

function clearanceOf(actor: Actor): ConfidentialityLevel[] {
  // A super-administrator is not limited by classification anywhere else either.
  return actor.isSuperAdmin
    ? [...CONFIDENTIALITY_LEVELS]
    : [...CLEARANCE_BY_MAX_LEVEL[actorClearance(actor)]];
}

/**
 * The same rule for one project already loaded — the project drive's root. The classification
 * gate must agree with `listVisible`, or a project hidden from the list for being above the
 * actor's clearance would still open by id.
 */
export function canSeeProject(
  actor: Actor,
  project: Pick<ProjectRecord, 'id' | 'departmentId' | 'memberUserIds' | 'leadUserId' | 'confidentiality'>,
): boolean {
  if (project.memberUserIds.includes(actor.userId) || project.leadUserId === actor.userId) return true;
  if (!clearanceOf(actor).includes(project.confidentiality)) return false;
  if (actor.isSuperAdmin || actorHasCompanyWideRead(actor)) return true;
  if (project.departmentId && actor.departmentId === project.departmentId) return true;
  return actor.grants.some(
    (grant) =>
      grant.scopeType === 'company' ||
      (grant.scopeType === 'project' && grant.scopeId === project.id) ||
      (grant.scopeType === 'department' && grant.scopeId === project.departmentId),
  );
}

export function visibleProjectsInput(actor: Actor): VisibleProjectsInput {
  return {
    organizationId: actor.organizationId,
    companyWide: actor.isSuperAdmin || actorHasCompanyWideRead(actor),
    clearance: clearanceOf(actor),
    userId: actor.userId,
    departmentId: actor.departmentId,
    departmentScopeIds: scopeIds(actor, 'department'),
    projectScopeIds: scopeIds(actor, 'project'),
  };
}
