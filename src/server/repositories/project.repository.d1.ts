/**
 * The D1 project repository.
 *
 * This is the module where the Phase 2 data-model decision finally has consequences:
 * MongoDB stores project membership **twice** — `projects.memberUserIds[]` and
 * `users.projectIds[]` — and D1 stores it once, in `project_members`.
 *
 * ── What that changes ───────────────────────────────────────────────────────────────────
 *
 * `syncMembership` does not exist here. In MongoDB it is the function that keeps the two
 * copies in step; in D1 there is nothing to keep in step, so writing membership *is* writing
 * `project_members`. The contract exposes `memberUserIds` as a field on `create` and
 * `updateById`, and both implementations make the whole write atomic — a Mongo session there,
 * `db.batch()` here.
 *
 * `listVisible`'s "projects I am a member of" branch becomes a subquery on `project_members`
 * rather than an array match. It is a subquery rather than a join so that no `DISTINCT` is
 * needed: a join against a membership table multiplies rows, and `DISTINCT` over a wide
 * `SELECT *` is a sort the query does not otherwise need.
 *
 * ── What is deliberately not added ──────────────────────────────────────────────────────
 *
 * No `deleted_at IS NULL`. `project.model.ts` does not call `applySoftDeleteFilter` — unlike
 * `experiment.model.ts`, which does, in the very same module. The asymmetry is real and is
 * reproduced rather than tidied; `softDelete` also sets `status = 'archived'`, and that is
 * what actually keeps a deleted project out of the places that matter.
 */
import { and, asc, eq, or, sql, type SQL } from 'drizzle-orm';
import { inList } from '@/server/db/d1-bindings';
import type { BatchItem } from 'drizzle-orm/batch';
import { withBatch, type Database } from '@/server/db/d1';
import { getD1 } from '@/server/db/d1-context';
import { projects, projectMembers } from '@/server/db/schema/research';
import { resourceTags } from '@/server/db/schema/drive';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type { ProjectStatus } from '@/server/db/models';
import type {
  CreateProjectInput,
  ProjectPatch,
  ProjectRecord,
  ProjectRepository,
  VisibleProjectsInput,
} from './project.repository.contract';

type ProjectRow = typeof projects.$inferSelect;

/** Mongo's implicit cap on a visible-projects listing. Reproduced rather than removed. */
const LIST_LIMIT = 500;

function nowIso(): string {
  return new Date().toISOString();
}

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Loads membership and tags for a page of projects in two queries, not two per row.
 *
 * `listVisible` is called on the drive landing page, so an N+1 here is on the first screen
 * every employee sees.
 */
async function hydrate(db: Database, rows: ProjectRow[]): Promise<ProjectRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [memberRows, tagRows] = await Promise.all([
    db
      .select({ projectId: projectMembers.projectId, userId: projectMembers.userId })
      .from(projectMembers)
      .where(inList(projectMembers.projectId, ids))
      .orderBy(asc(projectMembers.userId)),
    db
      .select({ resourceId: resourceTags.resourceId, tag: resourceTags.tag })
      .from(resourceTags)
      .where(
        and(eq(resourceTags.resourceType, 'project'), inList(resourceTags.resourceId, ids)),
      )
      .orderBy(asc(resourceTags.tag)),
  ]);

  const membersByProject = new Map<string, string[]>();
  for (const row of memberRows) {
    const list = membersByProject.get(row.projectId);
    if (list) list.push(row.userId);
    else membersByProject.set(row.projectId, [row.userId]);
  }

  const tagsByProject = new Map<string, string[]>();
  for (const row of tagRows) {
    const list = tagsByProject.get(row.resourceId);
    if (list) list.push(row.tag);
    else tagsByProject.set(row.resourceId, [row.tag]);
  }

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    departmentId: row.departmentId,
    name: row.name,
    code: row.code,
    description: row.description ?? '',
    leadUserId: row.leadUserId ?? null,
    memberUserIds: membersByProject.get(row.id) ?? [],
    rootFolderId: row.rootFolderId ?? null,
    status: row.status as ProjectStatus,
    confidentiality: row.confidentiality as ConfidentialityLevel,
    startDate: toDate(row.startDate),
    targetEndDate: toDate(row.targetEndDate),
    completedAt: toDate(row.completedAt),
    tags: tagsByProject.get(row.id) ?? [],
    storageUsedBytes: row.storageUsedBytes ?? 0,
    fileCount: row.fileCount ?? 0,
    createdAt: new Date(row.createdAt),
  }));
}

/* ------------------------------------------------------------------ reads */

export async function findById(id: string): Promise<ProjectRecord | null> {
  if (!id) return null;
  const db = await getD1();
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!row) return null;
  const [record] = await hydrate(db, [row]);
  return record ?? null;
}

export async function findByIds(ids: string[]): Promise<ProjectRecord[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await getD1();
  const rows = await db.select().from(projects).where(inList(projects.id, unique));
  return hydrate(db, rows);
}

export async function findByCode(
  organizationId: string,
  code: string,
): Promise<ProjectRecord | null> {
  if (!organizationId) return null;
  const db = await getD1();
  const [row] = await db
    .select()
    .from(projects)
    .where(
      and(eq(projects.organizationId, organizationId), eq(projects.code, code.toUpperCase())),
    )
    .limit(1);
  if (!row) return null;
  const [record] = await hydrate(db, [row]);
  return record ?? null;
}

export async function listVisible(input: VisibleProjectsInput): Promise<ProjectRecord[]> {
  if (!input.organizationId) return [];
  const db = await getD1();

  if (input.companyWide) {
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, input.organizationId))
      .orderBy(asc(projects.name))
      .limit(LIST_LIMIT);
    return hydrate(db, rows);
  }

  const branches: SQL[] = [];

  if (input.userId) {
    branches.push(
      sql`${projects.id} IN (SELECT ${projectMembers.projectId} FROM ${projectMembers} WHERE ${projectMembers.userId} = ${input.userId})`,
      eq(projects.leadUserId, input.userId),
    );
  }
  if (input.departmentId) branches.push(eq(projects.departmentId, input.departmentId));

  const departmentScopeIds = input.departmentScopeIds.filter(Boolean);
  if (departmentScopeIds.length) {
    branches.push(inList(projects.departmentId, departmentScopeIds));
  }

  const projectScopeIds = input.projectScopeIds.filter(Boolean);
  if (projectScopeIds.length) branches.push(inList(projects.id, projectScopeIds));

  // No branches means no way in — return nothing rather than an unfiltered organization list.
  if (branches.length === 0) return [];

  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.organizationId, input.organizationId), or(...branches)))
    .orderBy(asc(projects.name))
    .limit(LIST_LIMIT);

  return hydrate(db, rows);
}

/* ------------------------------------------------------------------ writes */

function memberStatements(
  db: Database,
  projectId: string,
  memberUserIds: string[],
  addedBy: string | null,
): BatchItem<'sqlite'>[] {
  const now = nowIso();
  const unique = [...new Set(memberUserIds.filter(Boolean))];

  // Replace the whole set: the caller computed the complete membership, exactly as the Mongo
  // path did when it handed `syncMembership` a full list.
  const statements: BatchItem<'sqlite'>[] = [
    db.delete(projectMembers).where(eq(projectMembers.projectId, projectId)),
  ];
  for (const userId of unique) {
    statements.push(
      db.insert(projectMembers).values({ projectId, userId, addedAt: now, addedBy }),
    );
  }
  return statements;
}

function tagStatements(
  db: Database,
  organizationId: string,
  projectId: string,
  tags: string[],
): BatchItem<'sqlite'>[] {
  const unique = [...new Set(tags.filter(Boolean))];
  const statements: BatchItem<'sqlite'>[] = [
    db
      .delete(resourceTags)
      .where(
        and(eq(resourceTags.resourceType, 'project'), eq(resourceTags.resourceId, projectId)),
      ),
  ];
  for (const tag of unique) {
    statements.push(
      db
        .insert(resourceTags)
        .values({ organizationId, resourceType: 'project', resourceId: projectId, tag }),
    );
  }
  return statements;
}

export async function create(input: CreateProjectInput): Promise<ProjectRecord> {
  const db = await getD1();
  const id = crypto.randomUUID();
  const now = nowIso();

  const statements: BatchItem<'sqlite'>[] = [
    db.insert(projects).values({
      id,
      organizationId: input.organizationId,
      departmentId: input.departmentId,
      name: input.name,
      code: input.code.toUpperCase(),
      description: input.description ?? '',
      leadUserId: input.leadUserId ?? null,
      rootFolderId: null,
      status: 'active',
      confidentiality: input.confidentiality,
      startDate: iso(input.startDate),
      targetEndDate: iso(input.targetEndDate),
      completedAt: null,
      storageUsedBytes: 0,
      fileCount: 0,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }),
    ...memberStatements(db, id, input.memberUserIds ?? [], input.createdBy),
    ...tagStatements(db, input.organizationId, id, input.tags ?? []),
  ];

  // One atomic list. A project whose membership did not land is a project its own members
  // cannot see, which is indistinguishable from the project not existing.
  await withBatch(db, statements);

  const created = await findById(id);
  if (!created) throw new Error(`Project ${id} disappeared immediately after insert`);
  return created;
}

function toColumns(patch: ProjectPatch): Partial<typeof projects.$inferInsert> {
  const columns: Partial<typeof projects.$inferInsert> = {};

  if (patch.name !== undefined) columns.name = patch.name;
  if (patch.description !== undefined) columns.description = patch.description;
  if (patch.leadUserId !== undefined) columns.leadUserId = patch.leadUserId;
  if (patch.rootFolderId !== undefined) columns.rootFolderId = patch.rootFolderId;
  if (patch.status !== undefined) columns.status = patch.status;
  if (patch.confidentiality !== undefined) columns.confidentiality = patch.confidentiality;
  if (patch.startDate !== undefined) columns.startDate = iso(patch.startDate);
  if (patch.targetEndDate !== undefined) columns.targetEndDate = iso(patch.targetEndDate);
  if (patch.completedAt !== undefined) columns.completedAt = iso(patch.completedAt);
  if (patch.storageUsedBytes !== undefined) columns.storageUsedBytes = patch.storageUsedBytes;
  if (patch.fileCount !== undefined) columns.fileCount = patch.fileCount;

  return columns;
}

export async function updateById(
  id: string,
  patch: ProjectPatch,
): Promise<ProjectRecord | null> {
  if (!id) return null;
  const db = await getD1();

  const existing = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  if (existing.length === 0) return null;
  const organizationId = existing[0]!.organizationId;

  const columns = toColumns(patch);
  const statements: BatchItem<'sqlite'>[] = [];

  if (Object.keys(columns).length > 0) {
    statements.push(
      db
        .update(projects)
        .set({ ...columns, updatedAt: nowIso() })
        .where(eq(projects.id, id)),
    );
  }
  if (patch.memberUserIds !== undefined) {
    statements.push(...memberStatements(db, id, patch.memberUserIds, null));
  }
  if (patch.tags !== undefined) {
    statements.push(...tagStatements(db, organizationId, id, patch.tags));
  }

  if (statements.length > 0) await withBatch(db, statements);
  return findById(id);
}

export async function softDelete(id: string, deletedBy: string): Promise<boolean> {
  if (!id) return false;
  const db = await getD1();
  const now = nowIso();
  const updated = await db
    .update(projects)
    .set({ deletedAt: now, deletedBy, status: 'archived', updatedAt: now })
    .where(eq(projects.id, id))
    .returning({ id: projects.id });
  return updated.length > 0;
}

export const d1ProjectRepository: ProjectRepository = {
  findById,
  findByIds,
  findByCode,
  listVisible,
  create,
  updateById,
  softDelete,
};
