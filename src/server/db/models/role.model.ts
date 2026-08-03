/**
 * Role — a named bundle of permissions, stored as data so administrators can create
 * their own without a deploy. Seeded from src/server/domain/roles.ts.
 *
 * `rank` enforces "you cannot grant a role more privileged than your own".
 * System roles cannot be deleted or renamed.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions, softDeleteFields } from '@/server/db/base-schema';
import { PERMISSIONS, SCOPE_TYPES, CONFIDENTIALITY_LEVELS } from '@/server/domain/permissions';

const roleSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    key: { type: String, required: true, trim: true, lowercase: true, maxlength: 60 },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: '', maxlength: 500 },

    permissions: { type: [String], enum: PERMISSIONS, default: [] },
    scopeTypes: { type: [String], enum: SCOPE_TYPES, default: [] },

    rank: { type: Number, required: true, min: 0, max: 100 },
    maxConfidentiality: { type: String, enum: CONFIDENTIALITY_LEVELS, default: 'internal' },
    companyWideRead: { type: Boolean, default: false },

    isSystem: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    ...softDeleteFields,
  },
  baseSchemaOptions,
);

roleSchema.index({ organizationId: 1, key: 1 }, { unique: true });
roleSchema.index({ organizationId: 1, rank: -1 });

export type RoleDocument = InferSchemaType<typeof roleSchema>;

export const RoleModel: Model<RoleDocument> =
  (models.Role as Model<RoleDocument>) ?? model<RoleDocument>('Role', roleSchema);
