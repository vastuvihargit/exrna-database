/**
 * Storage accounting — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_STORAGE_USAGE`.
 *
 * ── This flag has to move with files and versions ───────────────────────────────────────
 *
 * The counters are derived from `file_versions.file_size`, so an engine holding the counters but
 * not the versions cannot recompute them and cannot be reconciled — `recomputeAll` would zero
 * every quota. `DATA_SOURCE_DEPENDENCIES` records the requirement and the startup check refuses
 * the split.
 *
 * Note that `applyDelta` writes to `users`, `departments` and `projects` — tables owned by other
 * modules. That is why the dependency list for this one names identity and research rather than
 * just files: the write is genuinely cross-table, and on D1 it is one batch.
 */
import { isD1 } from './data-source';
import { mongoStorageUsageRepository } from './storage-usage.repository.mongo';
import { d1StorageUsageRepository } from './storage-usage.repository.d1';
import type {
  QuotaState,
  RecomputeResult,
  StorageUsageRepository,
  UsageDelta,
  UsageTx,
} from './storage-usage.repository.contract';

export type { QuotaState, RecomputeResult, StorageUsageRepository, UsageDelta, UsageTx };
export { quotaState } from './storage-usage.repository.contract';
export { mongoStorageUsageRepository, d1StorageUsageRepository };

function active(): StorageUsageRepository {
  return isD1('storageUsage') ? d1StorageUsageRepository : mongoStorageUsageRepository;
}

export function applyDelta(delta: UsageDelta, tx?: UsageTx): Promise<void> {
  return active().applyDelta(delta, tx);
}

export function getUserQuota(userId: string): Promise<QuotaState | null> {
  return active().getUserQuota(userId);
}

export function getDepartmentQuota(departmentId: string): Promise<QuotaState | null> {
  return active().getDepartmentQuota(departmentId);
}

export function recomputeAll(): Promise<RecomputeResult> {
  return active().recomputeAll();
}
