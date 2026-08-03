import { Types } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { LoginHistoryModel, type LoginHistoryDocument, type LoginOutcome } from '@/server/db/models';

export interface LoginAttemptInput {
  userId?: string | null;
  email: string;
  outcome: LoginOutcome;
  provider?: string;
  ip?: string;
  userAgent?: string;
  sessionId?: string | null;
  detail?: string | null;
}

export interface LoginHistoryRecord {
  id: string;
  userId: string | null;
  email: string;
  outcome: LoginOutcome;
  provider: string;
  ip: string;
  userAgent: string;
  detail: string | null;
  createdAt: Date;
}

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
  await connectToDatabase();
  await LoginHistoryModel.create({
    userId: input.userId && Types.ObjectId.isValid(input.userId) ? new Types.ObjectId(input.userId) : null,
    email: input.email.toLowerCase(),
    outcome: input.outcome,
    provider: input.provider ?? 'password',
    ip: input.ip ?? 'unknown',
    userAgent: input.userAgent ?? 'unknown',
    sessionId: input.sessionId && Types.ObjectId.isValid(input.sessionId) ? new Types.ObjectId(input.sessionId) : null,
    detail: input.detail ?? null,
  });
}

export async function listForUser(userId: string, limit = 50): Promise<LoginHistoryRecord[]> {
  if (!Types.ObjectId.isValid(userId)) return [];
  await connectToDatabase();
  const docs = await LoginHistoryModel.find({ userId: new Types.ObjectId(userId) })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 200))
    .lean<LeanLogin[]>()
    .exec();
  return docs.map(toRecord);
}

export interface AdminLoginHistoryQuery {
  email?: string;
  outcome?: LoginOutcome;
  page: number;
  pageSize: number;
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
      .sort({ createdAt: -1 })
      .skip((options.page - 1) * options.pageSize)
      .limit(options.pageSize)
      .lean<LeanLogin[]>()
      .exec(),
    LoginHistoryModel.countDocuments(filter).exec(),
  ]);

  return { items: docs.map(toRecord), total };
}
