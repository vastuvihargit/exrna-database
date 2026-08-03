/**
 * Department management. Departments are the coarsest access boundary in the system,
 * so creating and editing them is a company-level administrative action.
 */
import { getEnv } from '@/server/config/env';
import { ConflictError, NotFoundError, ValidationError } from '@/server/errors/app-error';
import * as departmentRepository from '@/server/repositories/department.repository';
import * as organizationRepository from '@/server/repositories/organization.repository';
import * as userRepository from '@/server/repositories/user.repository';
import { auditService } from '@/server/audit/audit.service';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { departmentVisibilityFilter } from '@/server/permissions/visibility';
import type { Actor } from '@/server/permissions/actor';
import type { RequestMeta } from '@/server/http/request-meta';

export async function list(actor: Actor) {
  // Every employee may see the department list — it is org-chart information, and the
  // drive navigation needs it. Contents remain permission-filtered.
  return departmentRepository.list(departmentVisibilityFilter(actor));
}

export async function getById(actor: Actor, id: string) {
  const department = await departmentRepository.findById(id);
  if (!department || department.organizationId !== actor.organizationId) throw new NotFoundError();
  return department;
}

export interface CreateDepartmentInput {
  name: string;
  code: string;
  description?: string;
  headUserId?: string | null;
  parentDepartmentId?: string | null;
  storageQuotaGb?: number;
}

export async function create(actor: Actor, input: CreateDepartmentInput, meta: RequestMeta) {
  assertCompanyPermission(actor, 'user.manage');

  const existing = await departmentRepository.findByCode(actor.organizationId, input.code);
  if (existing) throw new ConflictError('A department with this code already exists');

  if (input.headUserId) await assertMember(actor, input.headUserId);
  if (input.parentDepartmentId) {
    const parent = await departmentRepository.findById(input.parentDepartmentId);
    if (!parent || parent.organizationId !== actor.organizationId) {
      throw new ValidationError('Unknown parent department');
    }
  }

  const env = getEnv();
  const organization = await organizationRepository.getPrimary();
  const quotaBytes = input.storageQuotaGb
    ? input.storageQuotaGb * 1024 ** 3
    : (organization?.settings.defaultDepartmentQuotaBytes ?? env.defaultDepartmentQuotaBytes);

  const created = await departmentRepository.create({
    organizationId: actor.organizationId,
    name: input.name.trim(),
    code: input.code.trim().toUpperCase(),
    ...(input.description !== undefined ? { description: input.description } : {}),
    headUserId: input.headUserId ?? null,
    parentDepartmentId: input.parentDepartmentId ?? null,
    storageQuotaBytes: quotaBytes,
    createdBy: actor.userId,
  });

  await auditService.recordForActor(actor, meta, {
    action: 'department.created',
    entityType: 'department',
    entityId: created.id,
    entityLabel: `${created.code} — ${created.name}`,
    newValue: { name: created.name, code: created.code, storageQuotaBytes: created.storageQuotaBytes },
    severity: 'notice',
  });

  return created;
}

export async function update(
  actor: Actor,
  id: string,
  input: { name?: string; description?: string; headUserId?: string | null; storageQuotaGb?: number; isActive?: boolean },
  meta: RequestMeta,
) {
  assertCompanyPermission(actor, 'user.manage');

  const department = await departmentRepository.findById(id);
  if (!department || department.organizationId !== actor.organizationId) throw new NotFoundError();

  if (input.headUserId) await assertMember(actor, input.headUserId);

  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name.trim();
  if (input.description !== undefined) update.description = input.description;
  if (input.headUserId !== undefined) update.headUserId = input.headUserId;
  if (input.isActive !== undefined) update.isActive = input.isActive;
  if (input.storageQuotaGb !== undefined) update.storageQuotaBytes = input.storageQuotaGb * 1024 ** 3;

  if (Object.keys(update).length === 0) return department;

  const updated = await departmentRepository.updateById(id, { $set: update });
  if (!updated) throw new NotFoundError();

  await auditService.recordForActor(actor, meta, {
    action: 'department.updated',
    entityType: 'department',
    entityId: updated.id,
    entityLabel: `${updated.code} — ${updated.name}`,
    previousValue: {
      name: department.name,
      description: department.description,
      headUserId: department.headUserId,
      storageQuotaBytes: department.storageQuotaBytes,
      isActive: department.isActive,
    },
    newValue: update,
  });

  return updated;
}

export async function remove(actor: Actor, id: string, reason: string, meta: RequestMeta) {
  assertCompanyPermission(actor, 'user.manage');

  const department = await departmentRepository.findById(id);
  if (!department || department.organizationId !== actor.organizationId) throw new NotFoundError();

  // Deleting a department that still owns employees would orphan their access scope.
  const members = await userRepository.list({
    filter: { organizationId: actor.organizationId, departmentId: id },
    page: 1,
    pageSize: 1,
  });
  if (members.total > 0) {
    throw new ConflictError(
      `This department still has ${members.total} employee(s). Reassign them before deleting it.`,
    );
  }

  await departmentRepository.softDelete(id, actor.userId);

  await auditService.recordForActor(actor, meta, {
    action: 'department.deleted',
    entityType: 'department',
    entityId: id,
    entityLabel: `${department.code} — ${department.name}`,
    previousValue: { name: department.name, code: department.code },
    reason,
    severity: 'warning',
  });
}

async function assertMember(actor: Actor, userId: string): Promise<void> {
  const user = await userRepository.findById(userId);
  if (!user || user.organizationId !== actor.organizationId) {
    throw new ValidationError('Unknown employee');
  }
}

export const departmentService = { list, getById, create, update, remove };
