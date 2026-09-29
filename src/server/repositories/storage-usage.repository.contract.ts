/**
 * Storage accounting — the shape both engines implement.
 *
 * Usage counters live on the user, department and project rows rather than being summed on
 * demand: a quota check happens before every upload, and aggregating every version to answer it
 * would make uploading slower as the archive grows.
 *
 * They are therefore derived values that can drift, which is why `recomputeAll` exists and the
 * verification script runs it. **The authority is always the sum of version sizes**, never the
 * counter.
 *
 * ── The delta must be atomic, on both engines ───────────────────────────────────────────
 *
 * MongoDB used `$inc`, which is applied by the server. The D1 equivalent is
 * `SET storage_used_bytes = storage_used_bytes + ?`, for exactly the same reason: two concurrent
 * uploads by the same person must not both read the old value and both write their own total,
 * because the loser's bytes then occupy disk while being invisible to the quota. Neither engine
 * may read-modify-write in application code.
 *
 * ── Counters are clamped at zero ────────────────────────────────────────────────────────
 *
 * A negative delta larger than the stored value would otherwise leave a negative counter, and a
 * negative counter reads as "unlimited quota remaining". That can happen legitimately — a file
 * moved between departments before a drift was corrected — so both implementations floor at 0
 * rather than trusting the arithmetic.
 *
 * ── `recomputeAll` sums versions, not files ─────────────────────────────────────────────
 *
 * Every version occupies storage. A quota counting only current versions would let an unbounded
 * version history fill a volume while reporting plenty of room.
 */
import type { ClientSession } from 'mongoose';

/** A Mongoose session on the Mongo path; ignored on D1, which has no interactive transaction. */
export type UsageTx = ClientSession;

export interface UsageDelta {
  userId: string;
  departmentId?: string | null;
  projectId?: string | null;
  bytes: number;
}

export interface QuotaState {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
}

export interface RecomputeResult {
  users: number;
  departments: number;
  projects: number;
}

export interface StorageUsageRepository {
  /** Applies a signed delta to every counter an upload or deletion touches. Atomic per row. */
  applyDelta(delta: UsageDelta, tx?: UsageTx): Promise<void>;
  getUserQuota(userId: string): Promise<QuotaState | null>;
  getDepartmentQuota(departmentId: string): Promise<QuotaState | null>;
  /** Rebuilds every counter from the versions that actually exist. */
  recomputeAll(): Promise<RecomputeResult>;
}

/** Shared so both engines report the same shape for a row that exists. */
export function quotaState(usedBytes: number, quotaBytes: number): QuotaState {
  const used = Math.max(0, usedBytes);
  return {
    usedBytes: used,
    quotaBytes,
    remainingBytes: Math.max(0, quotaBytes - used),
  };
}
