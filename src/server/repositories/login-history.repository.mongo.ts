/**
 * The MongoDB login-history repository — the existing implementation, moved behind the contract.
 *
 * Two changes, both making the engines agree rather than changing production behaviour:
 *
 *   • `record()` no longer propagates a write failure. See the contract: this runs on the login
 *     path, and an attacker who can make it fail must not be able to turn that into a suppressed
 *     login *and* a 500. The failure is logged instead.
 *   • `deleteOlderThan` is new, because D1 has no TTL index. On MongoDB it is redundant with the
 *     400-day TTL and harmless — deleting rows the index would have deleted anyway.
 */
import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { LoginHistoryModel, type LoginHistoryDocument } from '@/server/db/models';
import { getLogger } from '@/server/logging/logger';
import {
  MAX_LOGIN_HISTORY_PAGE,
  type AdminLoginHistoryQuery,
  type LoginAttemptInput,
  type LoginHistoryRecord,
  type LoginHistoryRepository,
  type LoginOutcome,
} from './login-history.repository.contract';

type LeanLogin = LoginHistoryDocument & { _id: Types.ObjectId; createdAt: Date };

function toRecord(doc: LeanLogin): LoginHistoryRecord {
  return {
    id: String(doc._id),
    userId: doc.userId ? String(doc.userId) : null,
    email: doc.email,
    outcome: doc.outcome as LoginOutcome,
    provider: doc.provider,
    ip: doc.ip,
    userAgent: doc.userAgent,
    detail: doc.detail ?? null,
    createdAt: doc.createdAt,
  };
}

export async function record(input: LoginAttemptInput): Promise<void> {
  try {
    await connectToDatabase();
    await LoginHistoryModel.create({
      userId:
        input.userId && Types.ObjectId.isValid(input.userId)
          ? new Types.ObjectId(input.userId)
          : null,
      email: input.email.toLowerCase(),
      outcome: input.outcome,
      provider: input.provider ?? 'password',
      ip: input.ip ?? 'unknown',
      userAgent: input.userAgent ?? 'unknown',
      sessionId:
        input.sessionId && Types.ObjectId.isValid(input.sessionId)
          ? new Types.ObjectId(input.sessionId)
          : null,
      detail: input.detail ?? null,
    });
  } catch (error) {
    getLogger().error({ err: error, outcome: input.outcome }, 'Could not record a login attempt');
  }
}

export async function listForUser(userId: string, limit = 50): Promise<LoginHistoryRecord[]> {
  if (!Types.ObjectId.isValid(userId)) return [];
  await connectToDatabase();
  const docs = await LoginHistoryModel.find({ userId: new Types.ObjectId(userId) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(limit, MAX_LOGIN_HISTORY_PAGE))
    .lean<LeanLogin[]>()
    .exec();
  return docs.map(toRecord);
}

export async function query(
  options: AdminLoginHistoryQuery,
): Promise<{ items: LoginHistoryRecord[]; total: number }> {
  await connectToDatabase();

  const filter: Record<string, unknown> = {};
  if (options.email) filter.email = options.email.toLowerCase();
  if (options.outcome) filter.outcome = options.outcome;

  const [docs, total] = await Promise.all([
    LoginHistoryModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((options.page - 1) * options.pageSize)
      .limit(Math.min(options.pageSize, MAX_LOGIN_HISTORY_PAGE))
      .lean<LeanLogin[]>()
      .exec(),
    LoginHistoryModel.countDocuments(filter).exec(),
  ]);

  return { items: docs.map(toRecord), total };
}

export async function deleteOlderThan(cutoff: Date): Promise<number> {
  await connectToDatabase();
  const result = await LoginHistoryModel.deleteMany({ createdAt: { $lt: cutoff } }).exec();
  return result.deletedCount ?? 0;
}

export const mongoLoginHistoryRepository: LoginHistoryRepository = {
  record,
  listForUser,
  query,
  deleteOlderThan,
};
