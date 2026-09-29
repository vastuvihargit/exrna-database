/**
 * The MongoDB audit repository — append and query only.
 *
 * A faithful move behind the contract. The redaction and truncation rules moved out to
 * `audit-log.repository.contract.ts` so the two engines cannot disagree about which keys never
 * reach a log; nothing else changed.
 */
import { Types, type ClientSession } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { AuditLogModel, type AuditLogDocument } from '@/server/db/models';
import {
  sanitizeAuditValue,
  type AuditAppendInput,
  type AuditLogRepository,
  type AuditQueryOptions,
  type AuditRecord,
} from './audit-log.repository.contract';

export async function append(input: AuditAppendInput, session?: ClientSession): Promise<void> {
  await connectToDatabase();
  await AuditLogModel.create(
    [
      {
        organizationId: input.organizationId ? new Types.ObjectId(input.organizationId) : null,
        actorUserId: input.actorUserId ? new Types.ObjectId(input.actorUserId) : null,
        actorEmail: input.actorEmail ?? null,
        actorRoleKeys: input.actorRoleKeys ?? [],
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        entityLabel: input.entityLabel ?? null,
        previousValue: sanitizeAuditValue(input.previousValue),
        newValue: sanitizeAuditValue(input.newValue),
        reason: input.reason ?? null,
        ip: input.ip ?? 'unknown',
        userAgent: input.userAgent ?? 'unknown',
        requestId: input.requestId ?? null,
        outcome: input.outcome ?? 'success',
        severity: input.severity ?? 'info',
      },
    ],
    session ? { session } : undefined,
  );
}

type LeanAudit = AuditLogDocument & { _id: Types.ObjectId; createdAt: Date };

export async function query(
  options: AuditQueryOptions,
): Promise<{ items: AuditRecord[]; total: number }> {
  await connectToDatabase();

  const filter: Record<string, unknown> = {
    organizationId: new Types.ObjectId(options.organizationId),
  };
  if (options.action) filter.action = options.action;
  if (options.actorUserId && Types.ObjectId.isValid(options.actorUserId)) {
    filter.actorUserId = new Types.ObjectId(options.actorUserId);
  }
  if (options.entityType) filter.entityType = options.entityType;
  if (options.entityId) filter.entityId = options.entityId;
  if (options.outcome) filter.outcome = options.outcome;
  if (options.from || options.to) {
    filter.createdAt = {
      ...(options.from ? { $gte: options.from } : {}),
      ...(options.to ? { $lte: options.to } : {}),
    };
  }

  const [docs, total] = await Promise.all([
    AuditLogModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((options.page - 1) * options.pageSize)
      .limit(options.pageSize)
      .lean<LeanAudit[]>()
      .exec(),
    AuditLogModel.countDocuments(filter).exec(),
  ]);

  return {
    items: docs.map((doc) => ({
      id: String(doc._id),
      actorUserId: doc.actorUserId ? String(doc.actorUserId) : null,
      actorEmail: doc.actorEmail ?? null,
      actorRoleKeys: doc.actorRoleKeys ?? [],
      action: doc.action,
      entityType: doc.entityType,
      entityId: doc.entityId ?? null,
      entityLabel: doc.entityLabel ?? null,
      previousValue: doc.previousValue ?? null,
      newValue: doc.newValue ?? null,
      reason: doc.reason ?? null,
      ip: doc.ip,
      userAgent: doc.userAgent,
      requestId: doc.requestId ?? null,
      outcome: doc.outcome,
      severity: doc.severity,
      createdAt: doc.createdAt,
    })),
    total,
  };
}

export const mongoAuditLogRepository: AuditLogRepository = { append, query };
