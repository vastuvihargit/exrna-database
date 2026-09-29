/**
 * Project repository — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_PROJECTS`. See `user.repository.ts` for why this is a flag rather
 * than a swap.
 *
 * `syncMembership` is gone from the public surface. It existed to keep MongoDB's two copies of
 * project membership in step, and it was only ever called inside a `withTransaction` block
 * alongside `create` or `updateById`. Membership is now a field on those writes, and each
 * implementation makes the whole write atomic its own way — see the contract.
 */
import { isD1 } from './data-source';
import { mongoProjectRepository } from './project.repository.mongo';
import { d1ProjectRepository } from './project.repository.d1';
import type {
  CreateProjectInput,
  ProjectPatch,
  ProjectRecord,
  ProjectRepository,
  VisibleProjectsInput,
} from './project.repository.contract';

export type {
  CreateProjectInput,
  ProjectPatch,
  ProjectRecord,
  ProjectRepository,
  VisibleProjectsInput,
};

export { mongoProjectRepository, d1ProjectRepository };

function active(): ProjectRepository {
  return isD1('projects') ? d1ProjectRepository : mongoProjectRepository;
}

export function findById(id: string): Promise<ProjectRecord | null> {
  return active().findById(id);
}

export function findByIds(ids: string[]): Promise<ProjectRecord[]> {
  return active().findByIds(ids);
}

export function findByCode(
  organizationId: string,
  code: string,
): Promise<ProjectRecord | null> {
  return active().findByCode(organizationId, code);
}

export function listVisible(input: VisibleProjectsInput): Promise<ProjectRecord[]> {
  return active().listVisible(input);
}

export function create(input: CreateProjectInput): Promise<ProjectRecord> {
  return active().create(input);
}

export function updateById(id: string, patch: ProjectPatch): Promise<ProjectRecord | null> {
  return active().updateById(id, patch);
}

export function softDelete(id: string, deletedBy: string): Promise<boolean> {
  return active().softDelete(id, deletedBy);
}
