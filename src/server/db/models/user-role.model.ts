/**
 * A role granted to a user at a specific scope.
 *
 *   scopeType 'company'  → scopeId is null (applies everywhere)
 *   otherwise            → scopeId identifies the department / project / folder / file
 *
 * Grants are revoked rather than deleted so the history stays in the audit trail.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';
import { SCOPE_TYPES } from '@/server/domain/permissions';

const userRoleSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },

    scopeType: { type: String, enum: SCOPE_TYPES, required: true },
    scopeId: { type: Schema.Types.ObjectId, default: null },

    grantedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    grantedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  baseSchemaOptions,
);

// A user cannot hold the same role twice at the same scope while it is active.
userRoleSchema.index(
  { userId: 1, roleId: 1, scopeType: 1, scopeId: 1 },
  { unique: true, partialFilterExpression: { revokedAt: null } },
);
userRoleSchema.index({ userId: 1, revokedAt: 1 });
userRoleSchema.index({ scopeType: 1, scopeId: 1, revokedAt: 1 });
userRoleSchema.index({ expiresAt: 1 }, { sparse: true });

/** A company-scope grant must not carry a scopeId, and every other scope must. */
userRoleSchema.pre('validate', function preValidate(next) {
  const doc = this as unknown as { scopeType: string; scopeId: unknown };

  if (doc.scopeType === 'company' && doc.scopeId) {
    next(new Error('A company-scope role grant must not specify a scopeId'));
    return;
  }
  if (doc.scopeType !== 'company' && !doc.scopeId) {
    next(new Error(`A ${doc.scopeType}-scope role grant requires a scopeId`));
    return;
  }
  next();
});

export type UserRoleDocument = InferSchemaType<typeof userRoleSchema>;

export const UserRoleModel: Model<UserRoleDocument> =
  (models.UserRole as Model<UserRoleDocument>) ??
  model<UserRoleDocument>('UserRole', userRoleSchema);
