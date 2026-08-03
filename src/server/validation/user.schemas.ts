import { z } from 'zod';
import { SCOPE_TYPES } from '@/server/domain/permissions';
import { USER_STATUSES } from '@/server/db/models';
import { objectIdSchema, paginationSchema, searchSchema, sortSchema } from './common';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/server/auth/password';

export const listUsersQuerySchema = paginationSchema
  .merge(searchSchema)
  .merge(sortSchema)
  .extend({
    status: z.enum(USER_STATUSES).optional(),
    departmentId: objectIdSchema.optional(),
  });

export const createUserSchema = z
  .object({
    email: z.string().min(3).max(320),
    name: z.string().trim().min(2).max(200),
    jobTitle: z.string().trim().max(200).optional(),
    departmentId: objectIdSchema.nullable().optional(),
    // Only 'invited' or 'active' — you cannot create an already-deactivated employee.
    status: z.enum(['invited', 'active']).optional(),
    roleKey: z.string().trim().max(60).optional(),
    temporaryPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH).optional(),
    storageQuotaGb: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    jobTitle: z.string().trim().max(200).nullable().optional(),
    departmentId: objectIdSchema.nullable().optional(),
    storageQuotaGb: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();

/**
 * Status changes carry their own schema so `isSuperAdmin`, `email` and friends can
 * never ride along on this endpoint.
 */
export const setUserStatusSchema = z
  .object({
    status: z.enum(['active', 'suspended', 'deactivated']),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const grantRoleSchema = z
  .object({
    roleKey: z.string().trim().min(2).max(60).optional(),
    roleId: objectIdSchema.optional(),
    scopeType: z.enum(SCOPE_TYPES),
    scopeId: objectIdSchema.nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.roleKey || value.roleId), {
    message: 'Provide either roleKey or roleId',
  });

export const revokeRoleSchema = z.object({ grantId: objectIdSchema }).strict();

export const createDepartmentSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    code: z
      .string()
      .trim()
      .min(2)
      .max(20)
      .regex(/^[A-Za-z0-9-]+$/, 'Code may contain letters, digits and hyphens only'),
    description: z.string().trim().max(1000).optional(),
    headUserId: objectIdSchema.nullable().optional(),
    parentDepartmentId: objectIdSchema.nullable().optional(),
    storageQuotaGb: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();

export const updateDepartmentSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(1000).optional(),
    headUserId: objectIdSchema.nullable().optional(),
    storageQuotaGb: z.number().int().min(1).max(1_000_000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const deleteDepartmentSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

export const auditQuerySchema = paginationSchema.extend({
  action: z.string().max(60).optional(),
  actorUserId: objectIdSchema.optional(),
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(100).optional(),
  outcome: z.enum(['success', 'denied', 'error']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const loginHistoryQuerySchema = paginationSchema.extend({
  email: z.string().max(320).optional(),
  outcome: z.string().max(40).optional(),
});
