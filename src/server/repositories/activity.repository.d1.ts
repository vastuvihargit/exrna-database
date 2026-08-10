/**
 * The D1 activity repository.
 *
 * ── The write touches two tables, so it is one batch ────────────────────────────────────
 *
 * `contextFolderIds` was an array on the Mongo document; here it is rows in `activity_folders`.
 * A timeline row whose folder links failed to write is invisible in exactly the view it exists
 * for — the folder timeline — while still appearing in the entity timeline, so the two views
 * disagree and neither looks broken. `batch()` makes both commit or neither.
 *
 * ── `listForFolderTree` is a union, not an OR across tables ─────────────────────────────
 *
 * Mongo expressed "this folder, or anything whose context includes it" as `$or` over one
 * document. In SQL the second half lives in the join table, so the query is a `UNION` of the two
 * halves. Written as a union rather than a `LEFT JOIN … WHERE a OR b` because the join form
 * returns one row per matching folder link, so an activity recorded against three ancestor
 * folders would appear three times in a timeline — and `LIMIT` would then silently return fewer
 * distinct entries than it claims.
 *
 * ── Ordering is stable ──────────────────────────────────────────────────────────────────
 *
 * `created_at DESC, id DESC`. Several activities can share a millisecond — a folder move writes
 * one per affected item — and without the tiebreak the same row can appear on two pages while
 * another is skipped.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getD1 } from '@/server/db/d1-context';
import { activities, activityFolders } from '@/server/db/schema/audit';
import {
  MAX_ACTIVITY_PAGE,
  type ActivityEntityType,
  type ActivityRecord,
  type ActivityRepository,
  type AppendActivityInput,
} from './activity.repository.contract';

interface ActivityRow {
  id: string;
  actorUserId: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  detail: string | null;
  createdAt: string;
}

const recordColumns = {
  id: activities.id,
  actorUserId: activities.actorUserId,
  actorName: activities.actorName,
  action: activities.action,
  entityType: activities.entityType,
  entityId: activities.entityId,
  entityLabel: activities.entityLabel,
  detail: activities.detail,
  createdAt: activities.createdAt,
} as const;

function toRecord(row: ActivityRow): ActivityRecord {
  let detail: unknown = null;
  if (row.detail !== null) {
    try {
      detail = JSON.parse(row.detail);
    } catch {
      // A timeline entry is worth showing without its detail blob; throwing here would take
      // down the whole panel over one malformed row.
      detail = null;
    }
  }

  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    action: row.action,
    entityType: row.entityType as ActivityEntityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel ?? '',
    detail,
    createdAt: new Date(row.createdAt),
  };
}

export async function append(input: AppendActivityInput): Promise<void> {
  const db = await getD1();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const folderIds = [...new Set(input.contextFolderIds ?? [])];

  const statements: BatchItem<'sqlite'>[] = [
    db.insert(activities).values({
      id,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel ?? '',
      departmentId: input.departmentId ?? null,
      projectId: input.projectId ?? null,
      detail: input.detail === undefined || input.detail === null ? null : JSON.stringify(input.detail),
      createdAt: now,
    }),
  ];

  if (folderIds.length > 0) {
    statements.push(
      db
        .insert(activityFolders)
        .values(folderIds.map((folderId) => ({ activityId: id, folderId })))
        .onConflictDoNothing(),
    );
  }

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

export async function listForEntity(
  entityType: ActivityEntityType,
  entityId: string,
  limit = 50,
): Promise<ActivityRecord[]> {
  const db = await getD1();
  const rows = await db
    .select(recordColumns)
    .from(activities)
    .where(and(eq(activities.entityType, entityType), eq(activities.entityId, entityId)))
    .orderBy(desc(activities.createdAt), desc(activities.id))
    .limit(Math.min(limit, MAX_ACTIVITY_PAGE));

  return rows.map((row) => toRecord(row as ActivityRow));
}

export async function listForFolderTree(
  folderId: string,
  limit = 50,
): Promise<ActivityRecord[]> {
  const db = await getD1();
  const capped = Math.min(limit, MAX_ACTIVITY_PAGE);

  // A UNION rather than a join — see the header: the join form duplicates a row once per
  // matching folder link, and LIMIT would then return fewer distinct entries than it says.
  const rows = await db.all<ActivityRow>(sql`
    SELECT id, actor_user_id AS actorUserId, actor_name AS actorName, action,
           entity_type AS entityType, entity_id AS entityId, entity_label AS entityLabel,
           detail, created_at AS createdAt
      FROM activities
     WHERE (entity_type = 'folder' AND entity_id = ${folderId})
        OR id IN (SELECT activity_id FROM activity_folders WHERE folder_id = ${folderId})
     ORDER BY created_at DESC, id DESC
     LIMIT ${capped}
  `);

  return rows.map(toRecord);
}

export async function listForProject(
  projectId: string,
  limit = 30,
): Promise<ActivityRecord[]> {
  const db = await getD1();
  const rows = await db
    .select(recordColumns)
    .from(activities)
    .where(eq(activities.projectId, projectId))
    .orderBy(desc(activities.createdAt), desc(activities.id))
    .limit(Math.min(limit, MAX_ACTIVITY_PAGE));

  return rows.map((row) => toRecord(row as ActivityRow));
}

/**
 * Retention sweep.
 *
 * `activity_folders.activity_id` cascades, so the child rows go with their parents and no detach
 * step is needed here — unlike the session sweep, whose referencing columns have no cascade.
 *
 * The count comes from `RETURNING`, **not** from `meta.changes`, and that is the whole reason
 * this function is not a one-liner: D1 reports cascaded deletions in `meta.changes` as well as
 * direct ones. An activity with one folder link therefore counts as 2, and the sweep would
 * report roughly double what it removed — a number an operator would reasonably use to decide
 * whether retention is working. `RETURNING id` counts exactly the activities deleted.
 */
export async function deleteOlderThan(cutoff: Date): Promise<number> {
  const db = await getD1();
  const before = cutoff.toISOString();

  const deleted = await db
    .delete(activities)
    .where(lt(activities.createdAt, before))
    .returning({ id: activities.id });

  return deleted.length;
}

export const d1ActivityRepository: ActivityRepository = {
  append,
  listForEntity,
  listForFolderTree,
  listForProject,
  deleteOlderThan,
};
