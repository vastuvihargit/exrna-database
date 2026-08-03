/**
 * Every authentication attempt, successful or not.
 *
 * `userId` is null when the address does not match an account — the row still records
 * the attempt so credential-stuffing shows up in the admin view.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';

export const LOGIN_OUTCOMES = [
  'success',
  'bad_password',
  'unknown_user',
  'domain_rejected',
  'not_provisioned',
  'deactivated',
  'locked',
  'mfa_failed',
  'rate_limited',
  'oauth_error',
] as const;
export type LoginOutcome = (typeof LOGIN_OUTCOMES)[number];

const loginHistorySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    email: { type: String, required: true, lowercase: true, maxlength: 320 },
    outcome: { type: String, enum: LOGIN_OUTCOMES, required: true },
    provider: { type: String, default: 'password', maxlength: 32 },
    ip: { type: String, default: 'unknown', maxlength: 64 },
    userAgent: { type: String, default: 'unknown', maxlength: 512 },
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', default: null },
    detail: { type: String, default: null, maxlength: 300 },
  },
  baseSchemaOptions,
);

loginHistorySchema.index({ userId: 1, createdAt: -1 });
loginHistorySchema.index({ email: 1, createdAt: -1 });
loginHistorySchema.index({ outcome: 1, createdAt: -1 });
loginHistorySchema.index({ ip: 1, createdAt: -1 });
// Retained for 400 days; the permanent record of a security event is the audit log.
loginHistorySchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

export type LoginHistoryDocument = InferSchemaType<typeof loginHistorySchema>;

export const LoginHistoryModel: Model<LoginHistoryDocument> =
  (models.LoginHistory as Model<LoginHistoryDocument>) ??
  model<LoginHistoryDocument>('LoginHistory', loginHistorySchema);
