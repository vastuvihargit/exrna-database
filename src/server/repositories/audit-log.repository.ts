/**
 * Audit repository — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_AUDIT_LOGS`, and routable on its own: the audit trail references
 * nothing and nothing references it, so a record written to D1 while files are still on Mongo
 * is complete and readable. It is the one module in Phase 3 with no cross-module write
 * ordering to preserve.
 *
 * The trail *does* span the cutover, though, and that is a reporting fact worth stating: move
 * the flag and the admin audit page shows D1 records only. The Mongo collection is not deleted
 * — it is the rollback path and the historical record — so the migration copies it across
 * rather than leaving a gap. See the Phase 9 migration plan.
 */
import { isD1 } from './data-source';
import { mongoAuditLogRepository } from './audit-log.repository.mongo';
import { d1AuditLogRepository } from './audit-log.repository.d1';
import type {
  AuditAppendInput,
  AuditLogRepository,
  AuditQueryOptions,
  AuditRecord,
  AuditTx,
} from './audit-log.repository.contract';

export type { AuditAppendInput, AuditLogRepository, AuditQueryOptions, AuditRecord, AuditTx };

export { mongoAuditLogRepository, d1AuditLogRepository };
export { sanitizeAuditValue } from './audit-log.repository.contract';

function active(): AuditLogRepository {
  return isD1('auditLogs') ? d1AuditLogRepository : mongoAuditLogRepository;
}

export function append(input: AuditAppendInput, tx?: AuditTx): Promise<void> {
  return active().append(input, tx);
}

export function query(
  options: AuditQueryOptions,
): Promise<{ items: AuditRecord[]; total: number }> {
  return active().query(options);
}
