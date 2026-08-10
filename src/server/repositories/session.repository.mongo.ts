/**
 * The MongoDB session repository — the existing implementation, moved behind the contract.
 *
 * Behaviour is unchanged from before the split with two exceptions, both of which make the two
 * engines agree rather than changing what MongoDB does in production:
 *
 *   • the unused `ClientSession` parameters are gone (see the contract);
 *   • `deleteExpiredBefore` is new, because D1 has no TTL index and the sweep has to exist
 *     somewhere. On MongoDB it is redundant with the TTL index and harmless — deleting rows the
 *     index would have deleted anyway.
 */
import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { SessionModel, type SessionDocument } from '@/server/db/models';
import type {
  CreateSessionInput,
  LiveSessionRecord,
  SessionRecord,
  SessionRepository,
  SessionRevokeReason,
} from './session.repository.contract';

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

export async function create(input: CreateSessionInput): Promise<SessionRecord> {
  await connectToDatabase();
  const [doc] = await SessionModel.create([
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
  ]);
  return toRecord(doc!.toObject() as LeanSession);
}

export async function findLiveByTokenHash(tokenHash: string): Promise<LiveSessionRecord | null> {
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

export async function touch(id: string, idleExpiresAt: Date): Promise<void> {
  await connectToDatabase();
  await SessionModel.updateOne({ _id: new Types.ObjectId(id) }, [
    {
      $set: {
        lastUsedAt: new Date(),
        expiresAt: { $min: [idleExpiresAt, '$absoluteExpiresAt'] },
      },
    },
  ]).exec();
}

export async function revoke(id: string, reason: SessionRevokeReason): Promise<void> {
  await connectToDatabase();
  await SessionModel.updateOne(
    { _id: new Types.ObjectId(id), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  ).exec();
}

export async function revokeAllForUser(
  userId: string,
  reason: SessionRevokeReason,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  await connectToDatabase();

  const filter: Record<string, unknown> = {
    userId: new Types.ObjectId(userId),
    revokedAt: null,
  };
  if (options.exceptSessionId && Types.ObjectId.isValid(options.exceptSessionId)) {
    filter._id = { $ne: new Types.ObjectId(options.exceptSessionId) };
  }

  const result = await SessionModel.updateMany(filter, {
    $set: { revokedAt: new Date(), revokedReason: reason },
  }).exec();

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
  const doc = await SessionModel.findOne({ _id: new Types.ObjectId(id) })
    .lean<LeanSession>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function markRotated(id: string): Promise<void> {
  await connectToDatabase();
  await SessionModel.updateOne(
    { _id: new Types.ObjectId(id) },
    { $set: { rotatedAt: new Date(), revokedAt: new Date(), revokedReason: 'rotated' } },
  ).exec();
}

export async function deleteExpiredBefore(cutoff: Date): Promise<number> {
  await connectToDatabase();
  const result = await SessionModel.deleteMany({ absoluteExpiresAt: { $lt: cutoff } }).exec();
  return result.deletedCount ?? 0;
}

export const mongoSessionRepository: SessionRepository = {
  create,
  findLiveByTokenHash,
  touch,
  revoke,
  revokeAllForUser,
  listForUser,
  findById,
  markRotated,
  deleteExpiredBefore,
};
