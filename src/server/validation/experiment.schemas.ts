import { z } from 'zod';
import { objectIdSchema, paginationSchema } from './common';
import { EXPERIMENT_OUTCOMES, EXPERIMENT_STATUSES } from '@/server/db/models';

/**
 * An experiment code is printed on notebooks, tubes and plate maps, so it is constrained
 * to characters that survive being written by hand and typed back: letters, digits,
 * hyphen, underscore, dot. Anything else would be a code nobody can reliably re-enter.
 */
const experimentCode = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, numbers, dots, hyphens or underscores')
  .transform((value) => value.toUpperCase());

const shortText = (max: number) => z.string().trim().max(max);

const dateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((value) => !Number.isNaN(value.getTime()), 'Invalid date');

const nullableDate = z.union([dateInput, z.null()]);

const sampleIds = z.array(z.string().trim().min(1).max(60)).max(200);
const tags = z.array(z.string().trim().min(1).max(40)).max(25);

export const createExperimentSchema = z.object({
  projectId: objectIdSchema,
  code: experimentCode,
  title: z.string().trim().min(1).max(200),
  objective: shortText(4000).optional(),
  status: z.enum(EXPERIMENT_STATUSES).optional(),
  outcome: z.enum(EXPERIMENT_OUTCOMES).optional(),
  outcomeSummary: shortText(2000).optional(),
  leadUserId: z.union([objectIdSchema, z.null()]).optional(),
  collaboratorUserIds: z.array(objectIdSchema).max(50).optional(),
  protocolRef: shortText(200).optional(),
  instrumentRef: shortText(120).optional(),
  organism: shortText(120).optional(),
  sampleIds: sampleIds.optional(),
  startedOn: nullableDate.optional(),
  completedOn: nullableDate.optional(),
  folderId: z.union([objectIdSchema, z.null()]).optional(),
  tags: tags.optional(),
});

export const updateExperimentSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    objective: shortText(4000).optional(),
    status: z.enum(EXPERIMENT_STATUSES).optional(),
    outcome: z.enum(EXPERIMENT_OUTCOMES).optional(),
    outcomeSummary: shortText(2000).optional(),
    leadUserId: z.union([objectIdSchema, z.null()]).optional(),
    collaboratorUserIds: z.array(objectIdSchema).max(50).optional(),
    protocolRef: shortText(200).optional(),
    instrumentRef: shortText(120).optional(),
    organism: shortText(120).optional(),
    sampleIds: sampleIds.optional(),
    startedOn: nullableDate.optional(),
    completedOn: nullableDate.optional(),
    folderId: z.union([objectIdSchema, z.null()]).optional(),
    tags: tags.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const listExperimentsSchema = paginationSchema.extend({
  projectId: objectIdSchema.optional(),
  status: z.enum(EXPERIMENT_STATUSES).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  sampleId: z.string().trim().min(1).max(60).optional(),
});
