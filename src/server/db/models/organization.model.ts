/**
 * Organization — the tenant root.
 *
 * Single-tenant in the MVP (assumption A1), but every scoped document carries
 * organizationId so multi-tenancy is a configuration change rather than a migration.
 * Organization settings override the environment defaults at runtime, which lets an
 * admin change quotas and allowed file types without a redeploy.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions, softDeleteFields } from '@/server/db/base-schema';

const organizationSettingsSchema = new Schema(
  {
    allowAutoProvisioning: { type: Boolean, default: false },
    defaultUserQuotaBytes: { type: Number, required: true },
    defaultDepartmentQuotaBytes: { type: Number, required: true },
    maxUploadBytes: { type: Number, required: true },
    allowedExtensions: { type: [String], default: [] },
    blockedExtensions: { type: [String], default: [] },
    trashRetentionDays: { type: Number, default: 30 },
    requireApprovalForCategories: { type: [String], default: [] },
    allowSelfApproval: { type: Boolean, default: false },
  },
  { _id: false },
);

const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    /** Authoritative at runtime; seeded from COMPANY_EMAIL_DOMAINS. */
    emailDomains: { type: [String], required: true, default: [] },
    settings: { type: organizationSettingsSchema, required: true },
    storageUsedBytes: { type: Number, default: 0, min: 0 },
    fileCount: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    ...softDeleteFields,
  },
  baseSchemaOptions,
);

// `slug` is already uniquely indexed by its field definition above.
organizationSchema.index({ emailDomains: 1 });

export type OrganizationDocument = InferSchemaType<typeof organizationSchema>;

export const OrganizationModel: Model<OrganizationDocument> =
  (models.Organization as Model<OrganizationDocument>) ??
  model<OrganizationDocument>('Organization', organizationSchema);
