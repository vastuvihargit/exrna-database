import { z } from 'zod';
import { objectIdSchema, paginationSchema } from './common';
import { ACCESS_LEVELS, PRINCIPAL_TYPES } from '@/server/domain/permissions';

export const shareGrantSchema = z.object({
  principalType: z.enum(PRINCIPAL_TYPES),
  principalId: objectIdSchema,
  accessLevel: z.enum(ACCESS_LEVELS),
  /** A deny beats every allow. Governed by `access.manage`, not `share.internal`. */
  deny: z.boolean().optional(),
  expiresAt: z
    .string()
    .datetime()
    .transform((value) => new Date(value))
    .nullable()
    .optional(),
});

export const revokeShareSchema = z.object({
  principalType: z.enum(PRINCIPAL_TYPES),
  principalId: objectIdSchema,
});

export const setInheritanceSchema = z.object({
  inherit: z.boolean(),
});

export const sharedWithMeQuerySchema = paginationSchema;

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  parentCommentId: objectIdSchema.optional(),
  versionId: objectIdSchema.optional(),
});

export const editCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

export const resolveCommentSchema = z.object({
  resolved: z.boolean(),
});

export const listCommentsQuerySchema = z.object({
  includeResolved: z.coerce.boolean().default(false),
});

export const notificationsQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
