/**
 * Employee account.
 *
 * `status` is checked on every authenticated request, not only at login — that is what
 * makes deactivation take effect immediately (docs/phase-0/05).
 *
 * `passwordHash` and MFA secrets carry `select: false`: they are never loaded unless a
 * query asks for them explicitly, so they cannot leak through a generic read path.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions, softDeleteFields } from '@/server/db/base-schema';

export const USER_STATUSES = ['invited', 'active', 'suspended', 'deactivated'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const AUTH_PROVIDERS = ['password', 'google', 'microsoft'] as const;
export type AuthProviderName = (typeof AUTH_PROVIDERS)[number];

const authProviderSchema = new Schema(
  {
    provider: { type: String, enum: AUTH_PROVIDERS, required: true },
    providerAccountId: { type: String, default: null },
    linkedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const preferencesSchema = new Schema(
  {
    theme: { type: String, enum: ['system', 'light', 'dark'], default: 'system' },
    defaultView: { type: String, enum: ['list', 'grid'], default: 'list' },
    density: { type: String, enum: ['comfortable', 'compact'], default: 'comfortable' },
  },
  { _id: false },
);

const mfaSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    secret: { type: String, default: null, select: false },
    backupCodes: { type: [String], default: [], select: false },
    verifiedAt: { type: Date, default: null },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },

    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 320 },
    emailDomain: { type: String, required: true, lowercase: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    avatarUrl: { type: String, default: null },
    jobTitle: { type: String, default: null, maxlength: 200 },
    phone: { type: String, default: null, maxlength: 50 },

    authProviders: { type: [authProviderSchema], default: [] },
    passwordHash: { type: String, default: null, select: false },
    passwordUpdatedAt: { type: Date, default: null },
    mustChangePassword: { type: Boolean, default: false },
    mfa: { type: mfaSchema, default: () => ({}) },

    status: { type: String, enum: USER_STATUSES, default: 'invited', required: true },
    isSuperAdmin: { type: Boolean, default: false },

    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    /** Denormalized project membership — keeps the visibility filter to one query. */
    projectIds: { type: [Schema.Types.ObjectId], ref: 'Project', default: [] },

    storageQuotaBytes: { type: Number, required: true, min: 0 },
    storageUsedBytes: { type: Number, default: 0, min: 0 },

    lastLoginAt: { type: Date, default: null },
    lastActiveAt: { type: Date, default: null },
    failedLoginCount: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },

    preferences: { type: preferencesSchema, default: () => ({}) },

    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    invitedAt: { type: Date, default: null },
    activatedAt: { type: Date, default: null },
    deactivatedAt: { type: Date, default: null },
    deactivatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deactivationReason: { type: String, default: null, maxlength: 500 },

    ...softDeleteFields,
  },
  baseSchemaOptions,
);

// `email` is uniquely indexed by its field definition.
userSchema.index({ organizationId: 1, status: 1, departmentId: 1 });
userSchema.index({ organizationId: 1, projectIds: 1 });
userSchema.index({ lockedUntil: 1 }, { sparse: true });
userSchema.index({ name: 'text', email: 'text' });

export type UserDocument = InferSchemaType<typeof userSchema>;

export const UserModel: Model<UserDocument> =
  (models.User as Model<UserDocument>) ?? model<UserDocument>('User', userSchema);
