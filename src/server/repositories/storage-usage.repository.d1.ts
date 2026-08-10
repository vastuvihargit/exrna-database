/**
 * The D1 storage-usage repository.
 *
 * ── The delta is arithmetic inside the statement ────────────────────────────────────────
 *
 *     SET storage_used_bytes = MAX(0, storage_used_bytes + ?)
 *
 * The engine reads and writes the column in one operation, which is the whole point: two
 * concurrent uploads by the same person must not both read the old total and both write their
 * own. The loser's bytes would then be on disk and invisible to the quota — the failure is
 * silent, cumulative, and only discovered when a volume fills.
 *
 * `MAX(0, …)` is not defensive noise. A negative counter reads as *unlimited quota remaining*,
 * and a delta that overshoots is reachable: a file moved between departments before a drift was
 * corrected subtracts bytes the destination counter never held.
 *
 * ── The three rows go in one batch ──────────────────────────────────────────────────────
 *
 * An upload touches the user, the department and the project. Applying them as three separate
 * statements lets a failure land between them and leave the department charged for bytes the
 * user is not — a drift `recomputeAll` would later "fix" by overwriting both, hiding that
 * anything went wrong. One `batch()` makes all three commit or none.
 *
 * ── `recomputeAll` is a full-table sweep, and it stays on the read side of the quota ────
 *
 * It sums `file_versions.file_size` per file, joins the owner/department/project off `files`,
 * and rewrites every counter. Deliberately including soft-deleted files: a trashed file still
 * occupies storage until it is purged, and a quota that forgot it would let the trash become
 * free space.
 */
import { eq, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getD1 } from '@/server/db/d1-context';
import { departments, users } from '@/server/db/schema/identity';
import { projects } from '@/server/db/schema/research';
import {
  quotaState,
  type QuotaState,
  type RecomputeResult,
  type StorageUsageRepository,
  type UsageDelta,
} from './storage-usage.repository.contract';

export async function applyDelta(delta: UsageDelta): Promise<void> {
  const db = await getD1();
  const bytes = delta.bytes;

  const statements: BatchItem<'sqlite'>[] = [
    db
      .update(users)
      .set({ storageUsedBytes: sql`MAX(0, ${users.storageUsedBytes} + ${bytes})` })
      .where(eq(users.id, delta.userId)),
  ];

  if (delta.departmentId) {
    statements.push(
      db
        .update(departments)
        .set({ storageUsedBytes: sql`MAX(0, ${departments.storageUsedBytes} + ${bytes})` })
        .where(eq(departments.id, delta.departmentId)),
    );
  }

  if (delta.projectId) {
    statements.push(
      db
        .update(projects)
        .set({ storageUsedBytes: sql`MAX(0, ${projects.storageUsedBytes} + ${bytes})` })
        .where(eq(projects.id, delta.projectId)),
    );
  }

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

export async function getUserQuota(userId: string): Promise<QuotaState | null> {
  const db = await getD1();
  const [row] = await db
    .select({ used: users.storageUsedBytes, quota: users.storageQuotaBytes })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return row ? quotaState(row.used ?? 0, row.quota) : null;
}

export async function getDepartmentQuota(departmentId: string): Promise<QuotaState | null> {
  const db = await getD1();
  const [row] = await db
    .select({ used: departments.storageUsedBytes, quota: departments.storageQuotaBytes })
    .from(departments)
    .where(eq(departments.id, departmentId))
    .limit(1);

  return row ? quotaState(row.used ?? 0, row.quota) : null;
}

export async function recomputeAll(): Promise<RecomputeResult> {
  const db = await getD1();

  /**
   * One correlated-subquery UPDATE per table, and **no zeroing pass**.
   *
   * `COALESCE(SUM(…), 0)` already yields 0 for a row that owns nothing, so a separate
   * `SET storage_used_bytes = 0` would be both redundant and harmful: it opens a window in which
   * every quota reads as empty, and an upload landing in that window is admitted against a
   * counter that is about to be overwritten.
   *
   * The sum runs in SQL rather than by pulling the corpus into memory. The Node implementation
   * does `FileModel.find({})` over every file in the archive, which is exactly the shape a
   * Worker cannot afford — and this is the same computation expressed as three statements.
   *
   * Soft-deleted files are included deliberately: a trashed file still occupies storage until it
   * is purged, and a quota that forgot it would make the trash free space.
   */
  await db
    .update(users)
    .set({
      storageUsedBytes: sql`(
        SELECT COALESCE(SUM(fv.file_size), 0)
          FROM file_versions fv
          JOIN files f ON f.id = fv.file_id
         WHERE f.owner_id = ${users.id}
      )`,
    });

  await db
    .update(departments)
    .set({
      storageUsedBytes: sql`(
        SELECT COALESCE(SUM(fv.file_size), 0)
          FROM file_versions fv
          JOIN files f ON f.id = fv.file_id
         WHERE f.department_id = ${departments.id}
      )`,
    });

  await db
    .update(projects)
    .set({
      storageUsedBytes: sql`(
        SELECT COALESCE(SUM(fv.file_size), 0)
          FROM file_versions fv
          JOIN files f ON f.id = fv.file_id
         WHERE f.project_id = ${projects.id}
      )`,
    });

  // Reports rows that actually carry usage, matching what the Mongo implementation counts (the
  // size of its per-owner maps) rather than the size of each table.
  const [counts] = await db.all<{ users: number; departments: number; projects: number }>(sql`
    SELECT
      (SELECT COUNT(*) FROM users WHERE storage_used_bytes > 0)       AS users,
      (SELECT COUNT(*) FROM departments WHERE storage_used_bytes > 0) AS departments,
      (SELECT COUNT(*) FROM projects WHERE storage_used_bytes > 0)    AS projects
  `);

  return {
    users: Number(counts?.users ?? 0),
    departments: Number(counts?.departments ?? 0),
    projects: Number(counts?.projects ?? 0),
  };
}

export const d1StorageUsageRepository: StorageUsageRepository = {
  applyDelta,
  getUserQuota,
  getDepartmentQuota,
  recomputeAll,
};
