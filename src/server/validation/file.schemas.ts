import { z } from 'zod';
import { objectIdSchema, paginationSchema } from './common';
import { CONFIDENTIALITY_LEVELS } from '@/server/domain/permissions';
import { FILE_CATEGORIES } from '@/server/domain/file-types';

/**
 * The declared size is validated for shape only. The authoritative size is what the
 * server measures while streaming — a client that lies is caught at finalization, not
 * here.
 */
export const authorizeUploadSchema = z.object({
  folderId: objectIdSchema,
  filename: z.string().trim().min(1).max(300),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  mimeType: z.string().max(200).optional(),
  targetFileId: objectIdSchema.optional(),
  versionNote: z.string().max(1000).optional(),
  chunked: z.boolean().optional(),
});

export const chunkParamsSchema = z.object({
  chunkIndex: z.coerce.number().int().min(0).max(999_999),
});

export const renameFileSchema = z.object({
  name: z.string().trim().min(1).max(300),
});

export const moveFileSchema = z.object({
  targetFolderId: objectIdSchema,
});

export const copyFileSchema = z.object({
  targetFolderId: objectIdSchema,
});

export const updateFileSchema = z
  .object({
    tags: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
    confidentiality: z.enum(CONFIDENTIALITY_LEVELS).optional(),
    category: z.enum(FILE_CATEGORIES).optional(),
    projectId: objectIdSchema.nullable().optional(),
    experimentId: objectIdSchema.nullable().optional(),
    /**
     * Shape only. The keys and value types are checked against the research-metadata
     * allow-list in the service — a `z.record` here would happily accept `$where`.
     */
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const restoreVersionSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

export const updateVersionSchema = z.object({
  note: z.string().trim().max(1000),
});

export const listFilesQuerySchema = paginationSchema.extend({
  sort: z.enum(['displayName', 'updatedAt', 'createdAt', 'sizeBytes']).default('displayName'),
  order: z.enum(['asc', 'desc']).default('asc'),
  search: z.string().trim().min(1).max(80).optional(),
});
