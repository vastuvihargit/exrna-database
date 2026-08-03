import { z } from 'zod';
import { objectIdSchema, paginationSchema } from './common';
import { CONFIDENTIALITY_LEVELS } from '@/server/domain/permissions';
import { MAX_NAME_LENGTH } from '@/server/domain/naming';

/**
 * Names are validated here for shape and sanitized in the service for content. Both
 * are needed: this rejects the obviously wrong early with a clear message, the
 * sanitizer removes what a validator cannot express (bidi overrides, control codes).
 */
const folderNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a folder name')
  .max(MAX_NAME_LENGTH, `Folder names cannot be longer than ${MAX_NAME_LENGTH} characters`);

const confidentialitySchema = z.enum(CONFIDENTIALITY_LEVELS);

export const createFolderSchema = z.object({
  name: folderNameSchema,
  parentFolderId: objectIdSchema,
  description: z.string().max(2000).optional(),
  color: z.string().max(20).nullable().optional(),
  confidentiality: confidentialitySchema.optional(),
});

export const renameFolderSchema = z.object({
  name: folderNameSchema,
});

export const updateFolderSchema = z
  .object({
    description: z.string().max(2000).optional(),
    color: z.string().max(20).nullable().optional(),
    confidentiality: confidentialitySchema.optional(),
    inheritPermissions: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const moveFolderSchema = z.object({
  targetParentFolderId: objectIdSchema,
});

export const copyFolderSchema = z.object({
  targetParentFolderId: objectIdSchema,
});

export const starSchema = z.object({
  starred: z.boolean(),
});

export const listChildrenQuerySchema = paginationSchema.extend({
  sort: z.enum(['name', 'updatedAt', 'createdAt']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  search: z.string().trim().min(1).max(80).optional(),
});

export const trashQuerySchema = paginationSchema;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, numbers, dots, dashes or underscores'),
  departmentId: objectIdSchema,
  description: z.string().max(4000).optional(),
  leadUserId: objectIdSchema.nullable().optional(),
  memberUserIds: z.array(objectIdSchema).max(500).optional(),
  confidentiality: confidentialitySchema.optional(),
  startDate: z.coerce.date().optional(),
  targetEndDate: z.coerce.date().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
});

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    leadUserId: objectIdSchema.nullable().optional(),
    memberUserIds: z.array(objectIdSchema).max(500).optional(),
    status: z.enum(['planning', 'active', 'on_hold', 'completed', 'archived']).optional(),
    confidentiality: confidentialitySchema.optional(),
    targetEndDate: z.coerce.date().nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');
