/**
 * The audit trail — the shape both engines implement.
 *
 * ── Append and query. Nothing else. ─────────────────────────────────────────────────────
 *
 * There is deliberately no update and no delete on this interface, and adding one would be a
 * change to the *security posture* rather than to a repository. Immutability is defended in
 * three layers and this is the second:
 *
 *   1. the model rejects writes — Mongoose pre-hooks; on D1, `RAISE(ABORT)` triggers created in
 *      migration 0001 alongside the ones on `stock_transactions`;
 *   2. **this contract has no method that could be called to rewrite a row**;
 *   3. in production the database user has insert and find on this collection only.
 *
 * There is likewise no TTL and no retention index on either engine: retention is applied by an
 * explicit, audited archival job, never silently by the database.
 *
 * ── Redaction is policy, not storage ────────────────────────────────────────────────────
 *
 * `sanitizeAuditValue` lives here rather than in either implementation, because "what must
 * never be written to a log" is a rule about the product, not about the engine, and two copies
 * of it would eventually disagree about one key. Both repositories call it on the way in.
 */
import type { ClientSession } from 'mongoose';
import type { AuditAction, AuditOutcome } from '@/server/db/models/audit-log.model';

export type { AuditAction, AuditOutcome };

/** A Mongoose session on the Mongo path; ignored on D1, which has no interactive transaction. */
export type AuditTx = ClientSession;

export type AuditSeverity = 'info' | 'notice' | 'warning' | 'critical';

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
  severity?: AuditSeverity;
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

export interface AuditLogRepository {
  append(input: AuditAppendInput, tx?: AuditTx): Promise<void>;
  query(options: AuditQueryOptions): Promise<{ items: AuditRecord[]; total: number }>;
}

/** Serialized payloads above this are replaced by a marker rather than stored. */
export const MAX_AUDIT_VALUE_BYTES = 16 * 1024;

/**
 * Keys whose values never reach the audit trail.
 *
 * `storageKey` and `relativeStoragePath` are in here with the credentials for a reason that is
 * easy to miss: they are the coordinates of the bytes, and an audit reader who is allowed to
 * know *that* a file changed is not thereby allowed to know where it is stored.
 */
const REDACTED_KEYS = new Set([
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

/**
 * Caps a before/after payload so one large document cannot bloat the trail, and strips anything
 * that must never be written to a log at all.
 *
 * Recurses through arrays and plain objects; `Date` is passed through, because a redaction pass
 * that turned every date into `{}` would quietly destroy the timestamps a "before" snapshot
 * exists to preserve.
 */
export function sanitizeAuditValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;

  const redact = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(redact);
    if (input && typeof input === 'object' && !(input instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
        out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : redact(val);
      }
      return out;
    }
    return input;
  };

  const redacted = redact(value);
  const serialized = JSON.stringify(redacted);
  if (serialized && serialized.length > MAX_AUDIT_VALUE_BYTES) {
    return { truncated: true, bytes: serialized.length };
  }
  return redacted;
}
