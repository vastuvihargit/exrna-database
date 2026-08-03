import { z } from 'zod';
import { objectIdSchema, paginationSchema } from './common';
import { CONFIDENTIALITY_LEVELS } from '@/server/domain/permissions';
import { MIGRATION_ITEM_STATUSES } from '@/server/db/models';

/**
 * A Google Drive id.
 *
 * Google's ids are URL-safe base64-ish strings. Constraining the alphabet here means a
 * pasted value can never carry a quote into a Drive `q` expression or a separator into a
 * storage key, whatever the client sends.
 */
const driveId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, 'That does not look like a Google Drive folder id');

const migrationOptions = z.object({
  preserveHierarchy: z.boolean().optional(),
  preserveDates: z.boolean().optional(),
  skipDuplicates: z.boolean().optional(),
  exportGoogleDocs: z.boolean().optional(),
});

export const createMigrationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  targetFolderId: objectIdSchema,
  sourceFolderIds: z.array(driveId).max(50).optional(),
  confidentiality: z.enum(CONFIDENTIALITY_LEVELS).optional(),
  options: migrationOptions.optional(),
});

export const updateMigrationSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    sourceFolderIds: z.array(driveId).max(50).optional(),
    options: migrationOptions.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const completeConnectSchema = z.object({
  /** The authorization code from Google's redirect. Opaque, and short-lived. */
  code: z.string().trim().min(1).max(2000),
  state: z.string().trim().min(1).max(200),
});

export const runImportSchema = z.object({
  /**
   * Bounded so one HTTP request cannot try to import an entire Drive. The UI calls this
   * repeatedly and shows progress; any call can be the last without losing work.
   */
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const listMigrationItemsSchema = paginationSchema.extend({
  status: z.enum(MIGRATION_ITEM_STATUSES).optional(),
});
