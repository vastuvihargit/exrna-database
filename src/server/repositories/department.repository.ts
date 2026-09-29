/**
 * Department repository — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_DEPARTMENTS`. See `user.repository.ts` for why this is a flag rather
 * than a swap.
 */
import { isD1 } from './data-source';
import { mongoDepartmentRepository } from './department.repository.mongo';
import { d1DepartmentRepository } from './department.repository.d1';
import type {
  CreateDepartmentInput,
  DepartmentPatch,
  DepartmentRecord,
  DepartmentRepository,
  ListDepartmentsCriteria,
} from './department.repository.contract';

export type {
  CreateDepartmentInput,
  DepartmentPatch,
  DepartmentRecord,
  DepartmentRepository,
  ListDepartmentsCriteria,
};

export { mongoDepartmentRepository, d1DepartmentRepository };

function active(): DepartmentRepository {
  return isD1('departments') ? d1DepartmentRepository : mongoDepartmentRepository;
}

export function list(criteria: ListDepartmentsCriteria): Promise<DepartmentRecord[]> {
  return active().list(criteria);
}

export function findById(id: string): Promise<DepartmentRecord | null> {
  return active().findById(id);
}

export function findByIds(ids: string[]): Promise<DepartmentRecord[]> {
  return active().findByIds(ids);
}

export function findByCode(
  organizationId: string,
  code: string,
): Promise<DepartmentRecord | null> {
  return active().findByCode(organizationId, code);
}

export function create(input: CreateDepartmentInput): Promise<DepartmentRecord> {
  return active().create(input);
}

export function updateById(
  id: string,
  patch: DepartmentPatch,
): Promise<DepartmentRecord | null> {
  return active().updateById(id, patch);
}

export function softDelete(id: string, deletedBy: string): Promise<boolean> {
  return active().softDelete(id, deletedBy);
}

export function refreshMemberCount(departmentId: string): Promise<number> {
  return active().refreshMemberCount(departmentId);
}
