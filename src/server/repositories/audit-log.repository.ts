/**
 * Audit repository — append and query only.
 *
 * There is deliberately no update or delete function anywhere in this module. That is
 * the second of the three layers protecting the audit trail (the model rejects writes,
 * and in production the database user has insert+find on this collection only).
 */
import { Types, type ClientSession } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { AuditLogModel, type AuditAction, type AuditLogDocument, type AuditOutcome } from '@/server/db/models';

export interface AuditAppendInput {
  organizationId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorRoleKeys?: string[];
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  ip?: string;
  userAgent?: string;
  requestId?: string | null;
  outcome?: AuditOutcome;
  severity?: 'info' | 'notice' | 'warning' | 'critical';
}

const MAX_VALUE_BYTES = 16 * 1024;

/**
 * Caps a before/after payload so one large document cannot bloat the audit collection,
 * and strips anything that must never be written to a log at all.
 */
function sanitizeValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;

  const redactedKeys = new Set([
    'password',
    'passwordHash',
    'token',
    'tokenHash',
    'csrfToken',
    'csrfTokenHash',
    'secret',
    'storageKey',
    'relativeStoragePath',
    'authorization',
    'cookie',
  ]);

  const redact = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(redact);
    if (input && typeof input === 'object' && !(input instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
        out[key] = redactedKeys.has(key) ? '[redacted]' : redact(val);
      }
      return out;
    }
    return input;
  };

  const redacted = redact(value);
  const serialized = JSON.stringify(redacted);
  if (serialized && serialized.length > MAX_VALUE_BYTES) {
    return { truncated: true, bytes: serialized.length };
  }
  return redacted;
}

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
        previousValue: sanitizeValue(input.previousValue),
        newValue: sanitizeValue(input.newValue),
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

export interface AuditQueryOptions {
  organizationId: string;
  action?: AuditAction;
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
  outcome?: AuditOutcome;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export interface AuditRecord {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorRoleKeys: string[];
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  previousValue: unknown;
  newValue: unknown;
  reason: string | null;
  ip: string;
  userAgent: string;
  requestId: string | null;
  outcome: string;
  severity: string;
  createdAt: Date;
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
