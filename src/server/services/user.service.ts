/**
 * Employee management.
 *
 * There is no public registration anywhere in this system: accounts exist because an
 * administrator created them (or, if the organization enables it, because an approved
 * company address signed in through OAuth). Every function here is permission-checked
 * and audited.
 */
import { getEnv } from '@/server/config/env';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/server/errors/app-error';
import * as userRepository from '@/server/repositories/user.repository';
import * as roleRepository from '@/server/repositories/role.repository';
import * as departmentRepository from '@/server/repositories/department.repository';
import * as organizationRepository from '@/server/repositories/organization.repository';
import * as sessionRepository from '@/server/repositories/session.repository';
import { auditService } from '@/server/audit/audit.service';
import { assertCanGrantRole, assertCompanyPermission } from '@/server/permissions/authorize';
import type { Actor } from '@/server/permissions/actor';
import type { ScopeType } from '@/server/domain/permissions';
import type { RequestMeta } from '@/server/http/request-meta';
import { normalizeCompanyEmail } from '@/server/auth/email-domain';
import { checkPasswordPolicy, hashPassword } from '@/server/auth/password';
import { userDirectoryFilter } from '@/server/permissions/visibility';
import type { UserStatus } from '@/server/db/models';

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  jobTitle: string | null;
  avatarUrl: string | null;
  departmentId: string | null;
  status: UserStatus;
  isSuperAdmin: boolean;
  roles: Array<{ grantId: string; roleKey: string; roleName: string; scopeType: ScopeType; scopeId: string | null }>;
  storageQuotaBytes: number;
  storageUsedBytes: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  mfaEnabled: boolean;
  authProviders: string[];
}

/**
 * Directory entries visible to any active employee: identity and department only.
 * Status, quota and login timestamps are administrative and are stripped unless the
 * viewer holds `user.manage`.
 */
export interface DirectoryEntry {
  id: string;
  email: string;
  name: string;
  jobTitle: string | null;
  avatarUrl: string | null;
  departmentId: string | null;
}

function canManageUsers(actor: Actor): boolean {
  if (actor.isSuperAdmin) return true;
  return actor.grants.some(
    (grant) =>
      grant.permissions.includes('user.manage') &&
      (grant.scopeType === 'company' || grant.scopeType === 'department'),
  );
}

/** A department-scoped administrator may only manage their own department's employees. */
function assertCanManageTarget(actor: Actor, targetDepartmentId: string | null): void {
  if (actor.isSuperAdmin) return;

  const companyWide = actor.grants.some(
    (grant) => grant.scopeType === 'company' && grant.permissions.includes('user.manage'),
  );
  if (companyWide) return;

  const departmentScoped = actor.grants.some(
    (grant) =>
      grant.scopeType === 'department' &&
      grant.permissions.includes('user.manage') &&
      grant.scopeId === targetDepartmentId,
  );
  if (!departmentScoped) throw new ForbiddenError('You can only manage employees in your own department');
}

export async function listDirectory(
  actor: Actor,
  options: { search?: string; departmentId?: string; page: number; pageSize: number },
): Promise<{ items: DirectoryEntry[]; total: number }> {
  const { items, total } = await userRepository.list({
    filter: userDirectoryFilter(actor),
    ...(options.search ? { search: options.search } : {}),
    ...(options.departmentId ? { departmentId: options.departmentId } : {}),
    page: options.page,
    pageSize: options.pageSize,
  });

  return {
    items: items.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      jobTitle: user.jobTitle,
      avatarUrl: user.avatarUrl,
      departmentId: user.departmentId,
    })),
    total,
  };
}

export async function listForAdmin(
  actor: Actor,
  options: {
    search?: string;
    status?: UserStatus;
    departmentId?: string;
    page: number;
    pageSize: number;
    sort?: string;
    order?: 'asc' | 'desc';
  },
): Promise<{ items: UserSummary[]; total: number }> {
  if (!canManageUsers(actor)) throw new ForbiddenError();

  // A department-scoped admin is constrained to their own department, whatever they ask for.
  const scopedDepartment = actor.isSuperAdmin
    ? options.departmentId
    : actor.grants.some((grant) => grant.scopeType === 'company' && grant.permissions.includes('user.manage'))
      ? options.departmentId
      : (actor.departmentId ?? undefined);

  const { items, total } = await userRepository.list({
    filter: userDirectoryFilter(actor),
    ...(options.search ? { search: options.search } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(scopedDepartment ? { departmentId: scopedDepartment } : {}),
    page: options.page,
    pageSize: options.pageSize,
    ...(options.sort ? { sort: options.sort } : {}),
    ...(options.order ? { order: options.order } : {}),
  });

  const summaries = await Promise.all(items.map(async (user) => decorate(user)));
  return { items: summaries, total };
}

async function decorate(user: userRepository.UserRecord): Promise<UserSummary> {
  const grants = await roleRepository.listGrantsForUser(user.id);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    jobTitle: user.jobTitle,
    avatarUrl: user.avatarUrl,
    departmentId: user.departmentId,
    status: user.status,
    isSuperAdmin: user.isSuperAdmin,
    roles: grants.map((grant) => ({
      grantId: grant.id,
      roleKey: grant.roleKey,
      roleName: grant.roleName,
      scopeType: grant.scopeType,
      scopeId: grant.scopeId,
    })),
    storageQuotaBytes: user.storageQuotaBytes,
    storageUsedBytes: user.storageUsedBytes,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    mfaEnabled: user.mfaEnabled,
    authProviders: user.authProviders,
  };
}

export async function getById(actor: Actor, userId: string): Promise<UserSummary> {
  const user = await userRepository.findById(userId);
  if (!user || user.organizationId !== actor.organizationId) throw new NotFoundError();

  // You can always read your own record; otherwise this is an administrative view.
  if (user.id !== actor.userId && !canManageUsers(actor)) throw new ForbiddenError();
  return decorate(user);
}

export interface CreateEmployeeInput {
  email: string;
  name: string;
  jobTitle?: string;
  departmentId?: string | null;
  status?: Extract<UserStatus, 'invited' | 'active'>;
  roleKey?: string;
  temporaryPassword?: string;
  storageQuotaGb?: number;
}

export async function createEmployee(
  actor: Actor,
  input: CreateEmployeeInput,
  meta: RequestMeta,
): Promise<UserSummary> {
  if (!canManageUsers(actor)) throw new ForbiddenError();
  assertCanManageTarget(actor, input.departmentId ?? null);

  const env = getEnv();
  const allowedDomains = await organizationRepository.getSignInDomains(env.COMPANY_EMAIL_DOMAINS);
  const email = normalizeCompanyEmail(input.email, allowedDomains);

  // The company-domain rule applies to account creation too, not only to sign-in —
  // otherwise an admin could create a personal-email account that can never sign in.
  if (!email) {
    throw new ValidationError(
      `Email address must be on an approved company domain (${allowedDomains.join(', ')})`,
    );
  }

  const existing = await userRepository.findByEmail(email);
  if (existing) throw new ConflictError('An account with this email address already exists');

  if (input.departmentId) {
    const department = await departmentRepository.findById(input.departmentId);
    if (!department || department.organizationId !== actor.organizationId) {
      throw new ValidationError('Unknown department');
    }
  }

  let passwordHash: string | null = null;
  if (input.temporaryPassword) {
    const policy = checkPasswordPolicy(input.temporaryPassword, { email, name: input.name });
    if (!policy.ok) throw new ValidationError('Temporary password does not meet the policy', policy.problems);
    passwordHash = await hashPassword(input.temporaryPassword);
  }

  const organization = await organizationRepository.getPrimary();
  const quotaBytes = input.storageQuotaGb
    ? input.storageQuotaGb * 1024 ** 3
    : (organization?.settings.defaultUserQuotaBytes ?? env.defaultUserQuotaBytes);

  const created = await userRepository.create({
    organizationId: actor.organizationId,
    email,
    emailDomain: email.split('@')[1]!,
    name: input.name.trim(),
    jobTitle: input.jobTitle ?? null,
    status: input.status ?? 'invited',
    departmentId: input.departmentId ?? null,
    storageQuotaBytes: quotaBytes,
    passwordHash,
    invitedBy: actor.userId,
    ...(passwordHash ? { authProvider: 'password' as const } : {}),
  });

  if (input.roleKey) {
    await grantRole(
      actor,
      {
        userId: created.id,
        roleKey: input.roleKey,
        scopeType: input.departmentId ? 'department' : 'company',
        scopeId: input.departmentId ?? null,
      },
      meta,
    );
  }

  if (created.departmentId) await departmentRepository.refreshMemberCount(created.departmentId);

  await auditService.recordForActor(actor, meta, {
    action: 'user.created',
    entityType: 'user',
    entityId: created.id,
    entityLabel: created.email,
    newValue: {
      email: created.email,
      name: created.name,
      status: created.status,
      departmentId: created.departmentId,
    },
    severity: 'notice',
  });

  return decorate(created);
}

export async function updateEmployee(
  actor: Actor,
  userId: string,
  input: { name?: string; jobTitle?: string | null; departmentId?: string | null; storageQuotaGb?: number },
  meta: RequestMeta,
): Promise<UserSummary> {
  const target = await userRepository.findById(userId);
  if (!target || target.organizationId !== actor.organizationId) throw new NotFoundError();

  const isSelf = target.id === actor.userId;
  if (!isSelf) {
    if (!canManageUsers(actor)) throw new ForbiddenError();
    assertCanManageTarget(actor, target.departmentId);
  }

  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name.trim();
  if (input.jobTitle !== undefined) update.jobTitle = input.jobTitle;

  // Reassigning a department or changing a quota is administrative, never self-service.
  if (input.departmentId !== undefined) {
    if (isSelf && !canManageUsers(actor)) throw new ForbiddenError('You cannot change your own department');
    if (input.departmentId) {
      const department = await departmentRepository.findById(input.departmentId);
      if (!department || department.organizationId !== actor.organizationId) {
        throw new ValidationError('Unknown department');
      }
    }
    update.departmentId = input.departmentId;
  }
  if (input.storageQuotaGb !== undefined) {
    if (!canManageUsers(actor)) throw new ForbiddenError('You cannot change your own storage quota');
    update.storageQuotaBytes = input.storageQuotaGb * 1024 ** 3;
  }

  if (Object.keys(update).length === 0) return decorate(target);

  const updated = await userRepository.updateById(userId, { $set: update });
  if (!updated) throw new NotFoundError();

  if (target.departmentId !== updated.departmentId) {
    if (target.departmentId) await departmentRepository.refreshMemberCount(target.departmentId);
    if (updated.departmentId) await departmentRepository.refreshMemberCount(updated.departmentId);
  }

  await auditService.recordForActor(actor, meta, {
    action: input.storageQuotaGb !== undefined ? 'user.quota_changed' : 'user.updated',
    entityType: 'user',
    entityId: updated.id,
    entityLabel: updated.email,
    previousValue: {
      name: target.name,
      jobTitle: target.jobTitle,
      departmentId: target.departmentId,
      storageQuotaBytes: target.storageQuotaBytes,
    },
    newValue: update,
  });

  return decorate(updated);
}

export async function setStatus(
  actor: Actor,
  userId: string,
  status: Extract<UserStatus, 'active' | 'suspended' | 'deactivated'>,
  reason: string | null,
  meta: RequestMeta,
): Promise<UserSummary> {
  if (!canManageUsers(actor)) throw new ForbiddenError();

  const target = await userRepository.findById(userId);
  if (!target || target.organizationId !== actor.organizationId) throw new NotFoundError();
  assertCanManageTarget(actor, target.departmentId);

  // Locking yourself out, or removing the last administrator, are both self-inflicted
  // outages that no permission check would otherwise catch.
  if (target.id === actor.userId && status !== 'active') {
    throw new ValidationError('You cannot deactivate your own account');
  }
  if (target.isSuperAdmin && status !== 'active' && !actor.isSuperAdmin) {
    throw new ForbiddenError('Only a super administrator can deactivate a super administrator');
  }
  if (status !== 'active' && target.isSuperAdmin) {
    const remaining = await countActiveSuperAdmins(actor.organizationId);
    if (remaining <= 1) throw new ValidationError('At least one active super administrator must remain');
  }
  if (status !== 'active' && !reason) {
    throw new ValidationError('A reason is required when deactivating or suspending an employee');
  }

  const updated = await userRepository.updateById(userId, {
    $set: {
      status,
      ...(status === 'active'
        ? { activatedAt: new Date(), deactivatedAt: null, deactivatedBy: null, deactivationReason: null, failedLoginCount: 0, lockedUntil: null }
        : { deactivatedAt: new Date(), deactivatedBy: actor.userId, deactivationReason: reason }),
    },
  });
  if (!updated) throw new NotFoundError();

  // The immediate-access-loss guarantee: kill every live session right now. The
  // per-request status check in resolveSession() is the belt to this braces.
  let revoked = 0;
  if (status !== 'active') {
    revoked = await sessionRepository.revokeAllForUser(userId, 'user_deactivated');
  }

  if (updated.departmentId) await departmentRepository.refreshMemberCount(updated.departmentId);

  await auditService.recordForActor(actor, meta, {
    action: status === 'active' ? 'user.activated' : 'user.deactivated',
    entityType: 'user',
    entityId: updated.id,
    entityLabel: updated.email,
    previousValue: { status: target.status },
    newValue: { status, sessionsRevoked: revoked },
    reason,
    severity: 'warning',
  });

  return decorate(updated);
}

async function countActiveSuperAdmins(organizationId: string): Promise<number> {
  const { total } = await userRepository.list({
    filter: { organizationId, isSuperAdmin: true, status: 'active' },
    page: 1,
    pageSize: 1,
  });
  return total;
}

export interface GrantRoleInput {
  userId: string;
  roleKey?: string;
  roleId?: string;
  scopeType: ScopeType;
  scopeId: string | null;
  expiresAt?: Date | null;
}

export async function grantRole(
  actor: Actor,
  input: GrantRoleInput,
  meta: RequestMeta,
): Promise<void> {
  if (!canManageUsers(actor)) throw new ForbiddenError();

  const target = await userRepository.findById(input.userId);
  if (!target || target.organizationId !== actor.organizationId) throw new NotFoundError();
  assertCanManageTarget(actor, target.departmentId);

  const role = input.roleId
    ? await roleRepository.findRoleById(input.roleId)
    : input.roleKey
      ? await roleRepository.findRoleByKey(actor.organizationId, input.roleKey)
      : null;

  if (!role || role.organizationId !== actor.organizationId) throw new ValidationError('Unknown role');

  // Escalation guard: not above your own rank, and not a permission you lack.
  assertCanGrantRole(actor, role);

  if (!role.scopeTypes.includes(input.scopeType)) {
    throw new ValidationError(`Role "${role.name}" cannot be granted at ${input.scopeType} scope`);
  }
  if (input.scopeType === 'company' && input.scopeId) {
    throw new ValidationError('A company-scope grant must not specify a scope id');
  }
  if (input.scopeType !== 'company' && !input.scopeId) {
    throw new ValidationError(`A ${input.scopeType}-scope grant requires a scope id`);
  }

  const existing = await roleRepository.findActiveGrant(
    input.userId,
    role.id,
    input.scopeType,
    input.scopeId,
  );
  if (existing) throw new ConflictError('This role is already granted at that scope');

  await roleRepository.grantRole({
    organizationId: actor.organizationId,
    userId: input.userId,
    roleId: role.id,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    grantedBy: actor.userId,
    expiresAt: input.expiresAt ?? null,
  });

  // A permission change must take effect immediately, so existing sessions are dropped
  // and the actor is rebuilt on the target's next request.
  await sessionRepository.revokeAllForUser(input.userId, 'role_changed');

  await auditService.recordForActor(actor, meta, {
    action: 'user.role_granted',
    entityType: 'user',
    entityId: target.id,
    entityLabel: target.email,
    newValue: { roleKey: role.key, scopeType: input.scopeType, scopeId: input.scopeId },
    severity: 'warning',
  });
}

export async function revokeRole(
  actor: Actor,
  input: { userId: string; grantId: string },
  meta: RequestMeta,
): Promise<void> {
  if (!canManageUsers(actor)) throw new ForbiddenError();

  const target = await userRepository.findById(input.userId);
  if (!target || target.organizationId !== actor.organizationId) throw new NotFoundError();
  assertCanManageTarget(actor, target.departmentId);

  const grants = await roleRepository.listGrantsForUser(input.userId);
  const grant = grants.find((candidate) => candidate.id === input.grantId);
  if (!grant) throw new NotFoundError();

  if (!actor.isSuperAdmin && grant.rank >= actor.highestRank) {
    throw new ForbiddenError('You cannot revoke a role at or above your own privilege level');
  }

  await roleRepository.revokeGrant(input.grantId, actor.userId);
  await sessionRepository.revokeAllForUser(input.userId, 'role_changed');

  await auditService.recordForActor(actor, meta, {
    action: 'user.role_revoked',
    entityType: 'user',
    entityId: target.id,
    entityLabel: target.email,
    previousValue: { roleKey: grant.roleKey, scopeType: grant.scopeType, scopeId: grant.scopeId },
    severity: 'warning',
  });
}

export async function listRoles(actor: Actor) {
  assertCompanyPermission(actor, 'user.manage');
  return roleRepository.listRoles(actor.organizationId);
}

export const userService = {
  listDirectory,
  listForAdmin,
  getById,
  createEmployee,
  updateEmployee,
  setStatus,
  grantRole,
  revokeRole,
  listRoles,
};
