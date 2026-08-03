/**
 * Research project — the second sharing boundary after department, and the anchor that
 * connects files to research work.
 *
 * Phase 3 needs it so project drives can exist; Phase 9 extends it with experiments,
 * protocols and the project dashboard.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions, softDeleteFields, CONFIDENTIALITY_LEVELS } from '@/server/db/base-schema';

export const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const projectSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', required: true },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    /** Human-facing short identifier used in filenames and search, e.g. `EXR-2026-014`. */
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },
    description: { type: String, default: '', maxlength: 4000 },

    leadUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Denormalized onto users as `projectIds`; both are kept in step by the service. */
    memberUserIds: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },

    rootFolderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },

    status: { type: String, enum: PROJECT_STATUSES, default: 'active' },
    confidentiality: { type: String, enum: CONFIDENTIALITY_LEVELS, default: 'internal' },

    startDate: { type: Date, default: null },
    targetEndDate: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    tags: { type: [String], default: [] },
    storageUsedBytes: { type: Number, default: 0, min: 0 },
    fileCount: { type: Number, default: 0, min: 0 },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    ...softDeleteFields,
  },
  baseSchemaOptions,
);

projectSchema.index({ organizationId: 1, code: 1 }, { unique: true });
projectSchema.index({ organizationId: 1, departmentId: 1, status: 1 });
projectSchema.index({ memberUserIds: 1 });
projectSchema.index({ name: 'text', code: 'text', description: 'text', tags: 'text' });

export type ProjectDocument = InferSchemaType<typeof projectSchema>;

export const ProjectModel: Model<ProjectDocument> =
  (models.Project as Model<ProjectDocument>) ?? model<ProjectDocument>('Project', projectSchema);
