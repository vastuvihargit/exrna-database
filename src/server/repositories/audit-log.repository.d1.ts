/**
 * The D1 audit repository — append and query only.
 *
 * ── Immutability is the database's job here, not this module's ──────────────────────────
 *
 * Migration 0001 creates `trg_audit_logs_no_update` and `trg_audit_logs_no_delete`, both
 * `RAISE(ABORT)`. They are the D1 equivalent of the Mongoose pre-hooks and they are what makes
 * the guarantee hold against something that is *not* this file — a migration script, an admin
 * console, a future repository written by someone who did not read this comment. This module
 * simply has no method that would try.
 *
 * A consequence worth stating: `append` cannot be made idempotent by upserting, because an
 * upsert is an update. A duplicate audit row is the correct failure mode for a retried write —
 * two records of one attempt is a reporting nuisance, one record silently overwritten is
 * evidence destroyed.
 *
 * ── JSON columns ────────────────────────────────────────────────────────────────────────
 *
 * `previous_value`, `new_value` and `actor_role_keys` are TEXT holding JSON, because the
 * before/after snapshot is `Mixed` in Mongo and is read whole. They are parsed defensively on
 * the way out: an unparseable payload yields `null` rather than throwing, because one
 * malformed row must not make the audit page — the page an administrator opens *because*
 * something went wrong — fail to render.
 *
 * ── Organization scope ──────────────────────────────────────────────────────────────────
 *
 * `organization_id` is nullable, and that is deliberate: a failed login against an address
 * matching no account belongs to no tenant, and dropping it would erase exactly the events
 * credential-stuffing shows up as. `query` always filters by a *specific* organization, so
 * those rows are visible only to the system-level tooling that reads them directly.
 */
import { and, count, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { getD1 } from '@/server/db/d1-context';
import { auditLogs } from '@/server/db/schema/audit';
import {
  sanitizeAuditValue,
  type AuditAppendInput,
  type AuditLogRepository,
  type AuditQueryOptions,
  type AuditRecord,
  type AuditSeverity,
} from './audit-log.repository.contract';

type AuditRow = typeof auditLogs.$inferSelect;

function encode(value: unknown): string | null {
  const sanitized = sanitizeAuditValue(value);
  if (sanitized === null) return null;
  return JSON.stringify(sanitized);
}

function decode(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function decodeRoleKeys(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function toRecord(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    actorUserId: row.actorUserId ?? null,
    actorEmail: row.actorEmail ?? null,
    actorRoleKeys: decodeRoleKeys(row.actorRoleKeys),
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId ?? null,
    entityLabel: row.entityLabel ?? null,
    previousValue: decode(row.previousValue ?? null),
    newValue: decode(row.newValue ?? null),
    reason: row.reason ?? null,
    ip: row.ip,
    userAgent: row.userAgent,
    requestId: row.requestId ?? null,
    outcome: row.outcome,
    severity: row.severity,
    createdAt: new Date(row.createdAt),
  };
}

/**
 * Appends one record.
 *
 * The `tx` parameter of the contract is a Mongoose session and is **not honoured** here — it
 * cannot be. What replaces it is the ordering rule the audit service already follows: a success
 * event is recorded *after* the business write has committed, so a rolled-back write leaves no
 * "success" behind. The one Mongo call site that passed a session did so to get the opposite
 * guarantee (audit and action commit together); on D1 that becomes "audit after commit", which
 * can lose an audit row if the process dies in between but can never invent one for a write
 * that did not happen. Losing evidence of something that happened is recoverable from the
 * business record; inventing evidence of something that did not is not.
 */
export async function append(input: AuditAppendInput): Promise<void> {
  const db = await getD1();
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId ?? null,
    actorUserId: input.actorUserId ?? null,
    actorEmail: input.actorEmail ?? null,
    actorRoleKeys: JSON.stringify(input.actorRoleKeys ?? []),
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    entityLabel: input.entityLabel ?? null,
    previousValue: encode(input.previousValue),
    newValue: encode(input.newValue),
    reason: input.reason ?? null,
    ip: input.ip ?? 'unknown',
    userAgent: input.userAgent ?? 'unknown',
    requestId: input.requestId ?? null,
    outcome: input.outcome ?? 'success',
    severity: (input.severity ?? 'info') as AuditSeverity,
    createdAt: new Date().toISOString(),
  });
}

export async function query(
  options: AuditQueryOptions,
): Promise<{ items: AuditRecord[]; total: number }> {
  if (!options.organizationId) return { items: [], total: 0 };
  const db = await getD1();

  // Organization first and always. Every other filter narrows within one tenant; none of them
  // can widen past it, because they are ANDed onto this.
  const conditions: SQL[] = [eq(auditLogs.organizationId, options.organizationId)];
  if (options.action) conditions.push(eq(auditLogs.action, options.action));
  if (options.actorUserId) conditions.push(eq(auditLogs.actorUserId, options.actorUserId));
  if (options.entityType) conditions.push(eq(auditLogs.entityType, options.entityType));
  if (options.entityId) conditions.push(eq(auditLogs.entityId, options.entityId));
  if (options.outcome) conditions.push(eq(auditLogs.outcome, options.outcome));
  if (options.from) conditions.push(gte(auditLogs.createdAt, options.from.toISOString()));
  if (options.to) conditions.push(lte(auditLogs.createdAt, options.to.toISOString()));

  // Built once, used twice: the page and the count cannot describe different sets.
  const where = and(...conditions)!;

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(auditLogs)
      // The id tiebreak matters more here than elsewhere: several records of one request share
      // a timestamp to the millisecond, and an unstable order makes paging skip and repeat.
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .where(where)
      .limit(options.pageSize)
      .offset((options.page - 1) * options.pageSize),
    db.select({ value: count() }).from(auditLogs).where(where),
  ]);

  return { items: rows.map(toRecord), total: totals[0]?.value ?? 0 };
}

export const d1AuditLogRepository: AuditLogRepository = { append, query };
