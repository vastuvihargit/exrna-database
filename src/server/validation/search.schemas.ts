import { z } from 'zod';
import { objectIdSchema, paginationSchema } from './common';
import { CONFIDENTIALITY_LEVELS } from '@/server/domain/permissions';
import { FILE_CATEGORIES } from '@/server/domain/file-types';
import { METADATA_FIELD_KEYS } from '@/server/domain/research-metadata';
import { REVIEW_STATUSES, APPROVAL_STATUSES } from '@/server/db/models/file.model';

/**
 * A comma-separated query parameter, e.g. `tags=qpcr,plate3`.
 * Capped, because an unbounded `$all` array is a cheap way to make the server work hard.
 */
const csv = (max: number, itemMax: number) =>
  z
    .string()
    .max(max * (itemMax + 1))
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && part.length <= itemMax)
        .slice(0, max),
    );

/**
 * The free-text term.
 *
 * Length-capped and stripped of the operators MongoDB's `$text` treats specially, so a
 * user cannot turn a search box into a negation-only query that scans the whole index,
 * and a stray quote cannot make the query fail rather than return nothing.
 */
const textTerm = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .transform((value) => value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim())
  .refine((value) => value.length > 0, 'Enter something to search for');

const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((value) => !Number.isNaN(value.getTime()), 'Invalid date');

export const searchQuerySchema = paginationSchema.extend({
  q: textTerm.optional(),
  scope: z.enum(['all', 'files', 'folders']).default('all'),

  folderId: objectIdSchema.optional(),
  underFolderId: objectIdSchema.optional(),
  departmentId: objectIdSchema.optional(),
  projectId: objectIdSchema.optional(),
  experimentId: objectIdSchema.optional(),
  ownerId: objectIdSchema.optional(),

  category: z.enum(FILE_CATEGORIES).optional(),
  extension: z.string().trim().toLowerCase().max(20).regex(/^[a-z0-9]+$/).optional(),
  confidentiality: z.enum(CONFIDENTIALITY_LEVELS).optional(),
  reviewStatus: z.enum(REVIEW_STATUSES).optional(),
  approvalStatus: z.enum(APPROVAL_STATUSES).optional(),
  tags: csv(10, 40).optional(),

  /** Exact-match research metadata, e.g. `sampleId=S-1042`. */
  sampleId: z.string().trim().max(60).optional(),
  experimentCode: z.string().trim().max(60).optional(),
  study: z.string().trim().max(200).optional(),
  protocol: z.string().trim().max(200).optional(),
  instrument: z.string().trim().max(120).optional(),
  organism: z.string().trim().max(120).optional(),
  batchLot: z.string().trim().max(60).optional(),
  researcher: z.string().trim().max(120).optional(),
  documentType: z.string().trim().max(40).optional(),
  dataType: z.string().trim().max(40).optional(),

  updatedFrom: dateParam.optional(),
  updatedTo: dateParam.optional(),
  minSize: z.coerce.number().int().min(0).optional(),
  maxSize: z.coerce.number().int().min(0).optional(),
  includeArchived: z.coerce.boolean().default(false),

  sort: z.enum(['relevance', 'displayName', 'updatedAt', 'createdAt', 'sizeBytes']).default('relevance'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * The metadata filters, as a plain `{field: value}` map.
 *
 * Reads only from the declared allow-list, so the keys that reach a MongoDB dotted path
 * are always ones this codebase named — never a string from the request.
 */
export const METADATA_QUERY_KEYS = [
  'sampleId',
  'experimentCode',
  'study',
  'protocol',
  'instrument',
  'organism',
  'batchLot',
  'researcher',
  'documentType',
  'dataType',
] as const satisfies readonly (typeof METADATA_FIELD_KEYS)[number][];

export const saveSearchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  criteria: z.record(z.union([z.string(), z.number(), z.boolean()])).refine(
    (value) => Object.keys(value).length <= 30,
    'Too many search criteria to save',
  ),
  isPinned: z.boolean().optional(),
});

export const updateSavedSearchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    isPinned: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');
