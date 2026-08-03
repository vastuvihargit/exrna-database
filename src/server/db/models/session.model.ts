/**
 * Server-side session.
 *
 * The cookie carries an opaque random token; only its SHA-256 is stored, so a database
 * leak does not yield usable session cookies. Server-side sessions (rather than
 * self-contained JWTs) are what make revocation immediate — the brief requires a
 * deactivated employee to lose access at once.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';

export const SESSION_REVOKE_REASONS = [
  'logout',
  'logout_all',
  'rotated',
  'expired',
  'user_deactivated',
  'password_changed',
  'role_changed',
  'admin_revoked',
] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },

    tokenHash: { type: String, required: true, unique: true, select: false },
    csrfTokenHash: { type: String, required: true, select: false },

    /** Idle expiry, extended on use; absolute expiry is never extended. */
    expiresAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: Date.now },

    rotatedFromId: { type: Schema.Types.ObjectId, ref: 'Session', default: null },
    rotatedAt: { type: Date, default: null },

    ip: { type: String, default: 'unknown', maxlength: 64 },
    userAgent: { type: String, default: 'unknown', maxlength: 512 },
    deviceLabel: { type: String, default: 'Unknown device', maxlength: 128 },
    provider: { type: String, default: 'password', maxlength: 32 },

    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, enum: SESSION_REVOKE_REASONS, default: null },
  },
  baseSchemaOptions,
);

// `tokenHash` is uniquely indexed by its field definition — the authentication hot path.
sessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: -1 });
// The database expires rows as well as the code, so an unreachable app cannot leave
// live sessions behind. TTL fires on absolute expiry, never earlier.
sessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionDocument = InferSchemaType<typeof sessionSchema>;

export const SessionModel: Model<SessionDocument> =
  (models.Session as Model<SessionDocument>) ?? model<SessionDocument>('Session', sessionSchema);
