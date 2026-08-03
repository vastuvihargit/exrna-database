/**
 * Department — the primary organizational unit and the coarsest sharing boundary.
 * Each department owns a root folder (created in Phase 3) and a storage quota.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions, softDeleteFields } from '@/server/db/base-schema';

const departmentSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    description: { type: String, default: '', maxlength: 1000 },

    headUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    parentDepartmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    /** Populated in Phase 3 when department drives are created. */
    rootFolderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },

    storageQuotaBytes: { type: Number, required: true, min: 0 },
    storageUsedBytes: { type: Number, default: 0, min: 0 },
    memberCount: { type: Number, default: 0, min: 0 },

    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    ...softDeleteFields,
  },
  baseSchemaOptions,
);

departmentSchema.index({ organizationId: 1, code: 1 }, { unique: true });
departmentSchema.index({ organizationId: 1, isActive: 1, deletedAt: 1 });
departmentSchema.index({ headUserId: 1 });

export type DepartmentDocument = InferSchemaType<typeof departmentSchema>;

export const DepartmentModel: Model<DepartmentDocument> =
  (models.Department as Model<DepartmentDocument>) ??
  model<DepartmentDocument>('Department', departmentSchema);
