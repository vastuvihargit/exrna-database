/**
 * The activity timeline — the shape both engines implement.
 *
 * ── This is not the audit log, and the difference matters ───────────────────────────────
 *
 * The audit log is an append-only compliance record that normal users cannot read and nothing
 * may prune. This is the user-facing "what happened here" list: permission-filtered per viewer
 * and subject to retention. Writing one does not replace writing the other, and a change here is
 * never a change to what the audit trail recorded.
 *
 * ── An activity row carries a label, never content ──────────────────────────────────────
 *
 * `entityLabel` is a filename or a folder name. The caller has already been authorized against
 * the *container* — a project, a folder — before asking for its timeline, so the list is a record
 * of what happened in a place the viewer can already see. It is deliberately not a second route
 * to files they could not otherwise open, which is why nothing here returns file content and why
 * `detail` holds only what the writing service put there.
 *
 * ── `contextFolderIds` is a real table on D1 ────────────────────────────────────────────
 *
 * MongoDB stored an array on the document and queried it with an implicit `$in`. In D1 that is
 * `activity_folders`, because "every activity anywhere under this folder" has to be a join and a
 * JSON column cannot be indexed for it. The write therefore touches two tables, and both
 * implementations must make that one unit — a timeline row that lost its folder links is
 * invisible in exactly the view it was written for.
 */
import type { ClientSession } from 'mongoose';
import type { ActivityEntityType } from '@/server/db/models';

export type { ActivityEntityType };

/** A Mongoose session on the Mongo path; ignored on D1, which has no interactive transaction. */
export type ActivityTx = ClientSession;

export interface ActivityRecord {
  id: string;
  actorUserId: string;
  actorName: string;
  action: string;
  entityType: ActivityEntityType;
  entityId: string;
  entityLabel: string;
  detail: unknown;
  createdAt: Date;
}

export interface AppendActivityInput {
  organizationId: string;
  actorUserId: string;
  actorName: string;
  action: string;
  entityType: ActivityEntityType;
  entityId: string;
  entityLabel?: string;
  /** The folder chain this happened inside, so a folder timeline can find it. */
  contextFolderIds?: string[];
  departmentId?: string | null;
  projectId?: string | null;
  detail?: unknown;
}

export interface ActivityRepository {
  append(input: AppendActivityInput, tx?: ActivityTx): Promise<void>;
  /** Timeline for one entity, newest first. */
  listForEntity(
    entityType: ActivityEntityType,
    entityId: string,
    limit?: number,
  ): Promise<ActivityRecord[]>;
  /** Timeline for a folder, including everything that happened inside its subtree. */
  listForFolderTree(folderId: string, limit?: number): Promise<ActivityRecord[]>;
  listForProject(projectId: string, limit?: number): Promise<ActivityRecord[]>;
  /** Retention sweep. Returns how many rows were removed. */
  deleteOlderThan(cutoff: Date): Promise<number>;
}

export const MAX_ACTIVITY_PAGE = 200;
