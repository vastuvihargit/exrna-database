/**
 * Session repository.
 *
 * Lookup is by SHA-256 of the cookie value — the raw token is never stored, so a
 * database dump yields nothing replayable.
 */
import { Types, type ClientSession } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { SessionModel, type SessionDocument, type SessionRevokeReason } from '@/server/db/models';

export interface SessionRecord {
  id: string;
  userId: string;
  organizationId: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  lastUsedAt: Date;
  createdAt: Date;
  ip: string;
  userAgent: string;
  deviceLabel: string;
  provider: string;
  revokedAt: Date | null;
  rotatedAt: Date | null;
}

type LeanSession = SessionDocument & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

function toRecord(doc: LeanSession): SessionRecord {
  return {
    id: String(doc._id),
    userId: String(doc.userId),
    organizationId: String(doc.organizationId),
    expiresAt: doc.expiresAt,
    absoluteExpiresAt: doc.absoluteExpiresAt,
    lastUsedAt: doc.lastUsedAt,
    createdAt: doc.createdAt,
    ip: doc.ip,
    userAgent: doc.userAgent,
    deviceLabel: doc.deviceLabel,
    provider: doc.provider,
    revokedAt: doc.revokedAt ?? null,
    rotatedAt: doc.rotatedAt ?? null,
  };
}

export interface CreateSessionInput {
  userId: string;
  organizationId: string;
  tokenHash: string;
  csrfTokenHash: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  ip: string;
  userAgent: string;
  deviceLabel: string;
  provider: string;
  rotatedFromId?: string | null;
}

export async function create(input: CreateSessionInput, session?: ClientSession): Promise<SessionRecord> {
  await connectToDatabase();
  const [doc] = await SessionModel.create(
    [
      {
        userId: new Types.ObjectId(input.userId),
        organizationId: new Types.ObjectId(input.organizationId),
        tokenHash: input.tokenHash,
        csrfTokenHash: input.csrfTokenHash,
        expiresAt: input.expiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
        lastUsedAt: new Date(),
        ip: input.ip,
        userAgent: input.userAgent,
        deviceLabel: input.deviceLabel,
        provider: input.provider,
        rotatedFromId: input.rotatedFromId ? new Types.ObjectId(input.rotatedFromId) : null,
      },
    ],
    session ? { session } : undefined,
  );
  return toRecord(doc!.toObject() as LeanSession);
}

/**
 * Returns the session only if it is live: not revoked, and inside both the idle and
 * the absolute expiry. Expiry is part of the query, so an expired row can never be
 * treated as valid by a caller that forgets to check.
 */
export async function findLiveByTokenHash(
  tokenHash: string,
): Promise<(SessionRecord & { csrfTokenHash: string }) | null> {
  await connectToDatabase();
  const now = new Date();

  const doc = await SessionModel.findOne({
    tokenHash,
    revokedAt: null,
    expiresAt: { $gt: now },
    absoluteExpiresAt: { $gt: now },
  })
    .select('+csrfTokenHash')
    .lean<LeanSession & { csrfTokenHash: string }>()
    .exec();

  return doc ? { ...toRecord(doc), csrfTokenHash: doc.csrfTokenHash } : null;
}

/** Slides the idle window, capped by the absolute expiry. Throttled by the caller. */
export async function touch(id: string, idleExpiresAt: Date): Promise<void> {
  await connectToDatabase();
  await SessionModel.updateOne(
    { _id: new Types.ObjectId(id) },
    [
      {
        $set: {
          lastUsedAt: new Date(),
          expiresAt: { $min: [idleExpiresAt, '$absoluteExpiresAt'] },
        },
      },
    ],
  ).exec();
}

export async function revoke(id: string, reason: SessionRevokeReason): Promise<void> {
  await connectToDatabase();
  await SessionModel.updateOne(
    { _id: new Types.ObjectId(id), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  ).exec();
}

/**
 * Revokes every live session for a user. This is what makes deactivation, password
 * change and role change take effect immediately.
 */
export async function revokeAllForUser(
  userId: string,
  reason: SessionRevokeReason,
  options: { exceptSessionId?: string; session?: ClientSession } = {},
): Promise<number> {
  await connectToDatabase();

  const filter: Record<string, unknown> = {
    userId: new Types.ObjectId(userId),
    revokedAt: null,
  };
  if (options.exceptSessionId && Types.ObjectId.isValid(options.exceptSessionId)) {
    filter._id = { $ne: new Types.ObjectId(options.exceptSessionId) };
  }

  const result = await SessionModel.updateMany(
    filter,
    { $set: { revokedAt: new Date(), revokedReason: reason } },
    options.session ? { session: options.session } : undefined,
  ).exec();

  return result.modifiedCount;
}

export async function listForUser(userId: string): Promise<SessionRecord[]> {
  await connectToDatabase();
  const now = new Date();
  const docs = await SessionModel.find({
    userId: new Types.ObjectId(userId),
    revokedAt: null,
    absoluteExpiresAt: { $gt: now },
  })
    .sort({ lastUsedAt: -1 })
    .limit(50)
    .lean<LeanSession[]>()
    .exec();
  return docs.map(toRecord);
}

export async function findById(id: string): Promise<SessionRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectToDatabase();
  const doc = await SessionModel.findOne({ _id: new Types.ObjectId(id) }).lean<LeanSession>().exec();
  return doc ? toRecord(doc) : null;
}

export async function markRotated(id: string): Promise<void> {
  await connectToDatabase();
  await SessionModel.updateOne(
    { _id: new Types.ObjectId(id) },
    { $set: { rotatedAt: new Date(), revokedAt: new Date(), revokedReason: 'rotated' } },
  ).exec();
}
