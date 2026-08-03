/**
 * An experiment — the unit of research work a file can be traced back to.
 *
 * This is deliberately thin. A laboratory information management system would model
 * runs, plates, aliquots and instrument bookings; the brief is explicit that this must
 * not become one. What an experiment is here is a *named anchor*: a code, a project, the
 * people who ran it, the samples and protocol it touched, and a date. Files point at it.
 * That is enough to answer "what produced this file?" and "what else came out of this
 * run?", which are the two questions the drive actually needs.
 *
 * An experiment always belongs to a project. There is no free-floating experiment,
 * because access to an experiment is derived from access to its project — no project
 * would mean no boundary to check.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import {
  applySoftDeleteFilter,
  baseSchemaOptions,
  softDeleteFields,
  CONFIDENTIALITY_LEVELS,
} from '@/server/db/base-schema';

export const EXPERIMENT_STATUSES = [
  'planned',
  'in_progress',
  'completed',
  'aborted',
  'archived',
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/** Mirrors the `result` research-metadata field, so a file and its experiment speak the same vocabulary. */
export const EXPERIMENT_OUTCOMES = ['pending', 'positive', 'negative', 'inconclusive', 'failed'] as const;
export type ExperimentOutcome = (typeof EXPERIMENT_OUTCOMES)[number];

const experimentSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    /** Denormalized from the project so department-scoped queries need one lookup. */
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },

    /** Human-facing identifier, e.g. `EXP-2026-014`. Matched against `metadata.experimentCode`. */
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 60 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    objective: { type: String, default: '', maxlength: 4000 },

    status: { type: String, enum: EXPERIMENT_STATUSES, default: 'planned' },
    outcome: { type: String, enum: EXPERIMENT_OUTCOMES, default: 'pending' },
    outcomeSummary: { type: String, default: '', maxlength: 2000 },

    leadUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    collaboratorUserIds: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },

    /**
     * References, not foreign keys. Protocols and instruments are documents and assets
     * that live elsewhere in the company; modelling them as collections here would be the
     * first step towards the LIMS this is not supposed to be.
     */
    protocolRef: { type: String, default: '', trim: true, maxlength: 200 },
    instrumentRef: { type: String, default: '', trim: true, maxlength: 120 },
    organism: { type: String, default: '', trim: true, maxlength: 120 },
    /** Sample identifiers as printed on the tubes. Deduplicated and capped by the service. */
    sampleIds: { type: [String], default: [] },

    startedOn: { type: Date, default: null },
    completedOn: { type: Date, default: null },

    /** Optional home folder, normally `04_Experiments/<code>` in the project drive. */
    folderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },

    confidentiality: { type: String, enum: CONFIDENTIALITY_LEVELS, default: 'internal' },
    tags: { type: [String], default: [] },
    /** Maintained by the file service as files are linked and unlinked. */
    fileCount: { type: Number, default: 0, min: 0 },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    ...softDeleteFields,
  },
  baseSchemaOptions,
);

applySoftDeleteFilter(experimentSchema);

/**
 * Codes are unique per organization rather than per project: an experiment code is
 * printed on notebooks and sample tubes, and two different experiments answering to
 * `EXP-014` in different projects is exactly the ambiguity this platform exists to end.
 */
experimentSchema.index({ organizationId: 1, code: 1 }, { unique: true });
experimentSchema.index({ projectId: 1, deletedAt: 1, code: 1 });
experimentSchema.index({ organizationId: 1, departmentId: 1, status: 1 });
experimentSchema.index({ organizationId: 1, sampleIds: 1 });
experimentSchema.index({ leadUserId: 1 });

experimentSchema.index(
  { code: 'text', title: 'text', objective: 'text', sampleIds: 'text', tags: 'text' },
  {
    name: 'experiment_search',
    weights: { code: 10, title: 8, sampleIds: 6, tags: 4, objective: 1 },
  },
);

export type ExperimentDocument = InferSchemaType<typeof experimentSchema>;

export const ExperimentModel: Model<ExperimentDocument> =
  (models.Experiment as Model<ExperimentDocument>) ??
  model<ExperimentDocument>('Experiment', experimentSchema);
