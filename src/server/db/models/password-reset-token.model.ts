/**
 * Single-use password reset token.
 *
 * Only the SHA-256 of the token is stored, and the row is consumed (not deleted) so a
 * replay attempt is distinguishable from an unknown token. TTL removes expired rows.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';

const passwordResetTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    requestedIp: { type: String, default: 'unknown', maxlength: 64 },
  },
  baseSchemaOptions,
);

passwordResetTokenSchema.index({ userId: 1, usedAt: 1 });
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export type PasswordResetTokenDocument = InferSchemaType<typeof passwordResetTokenSchema>;

export const PasswordResetTokenModel: Model<PasswordResetTokenDocument> =
  (models.PasswordResetToken as Model<PasswordResetTokenDocument>) ??
  model<PasswordResetTokenDocument>('PasswordResetToken', passwordResetTokenSchema);
