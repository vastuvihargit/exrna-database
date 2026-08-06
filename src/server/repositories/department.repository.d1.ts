/**
 * The D1 department repository.
 *
 * Verified against `department.repository.mongo.ts` by the shared suite in
 * `tests/d1/user-department-repository.test.ts`.
 *
 * The one thing worth reading twice is in `list()`: soft-deleted departments are **included**
 * by default, because that is what MongoDB does here. See the note in the contract.
 */
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { getD1 } from '@/server/db/d1-context';
import { departments, users } from '@/server/db/schema/identity';
import type {
  CreateDepartmentInput,
  DepartmentPatch,
  DepartmentRecord,
  DepartmentRepository,
  ListDepartmentsCriteria,
} from './department.repository.contract';

type DepartmentRow = typeof departments.$inferSelect;

function nowIso(): string {
  return new Date().toISOString();
}

function toRecord(row: DepartmentRow): DepartmentRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    code: row.code,
    description: row.description ?? '',
    headUserId: row.headUserId ?? null,
    parentDepartmentId: row.parentDepartmentId ?? null,
    rootFolderId: row.rootFolderId ?? null,
    storageQuotaBytes: row.storageQuotaBytes,
    storageUsedBytes: row.storageUsedBytes ?? 0,
    memberCount: row.memberCount ?? 0,
    isActive: Boolean(row.isActive),
    createdAt: new Date(row.createdAt),
  };
}

export async function list(criteria: ListDepartmentsCriteria): Promise<DepartmentRecord[]> {
  const db = await getD1();

  const where =
    criteria.includeDeleted === false
      ? and(eq(departments.organizationId, criteria.organizationId), sql`${departments.deletedAt} IS NULL`)
      : eq(departments.organizationId, criteria.organizationId);

  const rows = await db
    .select()
    .from(departments)
    .where(where)
    .orderBy(sql`${departments.name} ASC`);

  return rows.map(toRecord);
}

export async function findById(id: string): Promise<DepartmentRecord | null> {
  if (!id) return null;
  const db = await getD1();
  const [row] = await db.select().from(departments).where(eq(departments.id, id)).limit(1);
  return row ? toRecord(row) : null;
}

export async function findByIds(ids: string[]): Promise<DepartmentRecord[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await getD1();
  const rows = await db.select().from(departments).where(inArray(departments.id, unique));
  return rows.map(toRecord);
}

export async function findByCode(
  organizationId: string,
  code: string,
): Promise<DepartmentRecord | null> {
  const db = await getD1();
  const [row] = await db
    .select()
    .from(departments)
    .where(
      and(
        eq(departments.organizationId, organizationId),
        eq(departments.code, code.toUpperCase()),
      ),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

export async function create(input: CreateDepartmentInput): Promise<DepartmentRecord> {
  const db = await getD1();
  const now = nowIso();
  const id = crypto.randomUUID();

  await db.insert(departments).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    code: input.code.toUpperCase(),
    description: input.description ?? '',
    headUserId: input.headUserId ?? null,
    parentDepartmentId: input.parentDepartmentId ?? null,
    rootFolderId: null,
    storageQuotaBytes: input.storageQuotaBytes,
    storageUsedBytes: 0,
    memberCount: 0,
    isActive: true,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  const created = await findById(id);
  if (!created) throw new Error(`Department ${id} disappeared immediately after insert`);
  return created;
}

function toColumns(patch: DepartmentPatch): Partial<typeof departments.$inferInsert> {
  const columns: Partial<typeof departments.$inferInsert> = {};

  if (patch.name !== undefined) columns.name = patch.name;
  if (patch.description !== undefined) columns.description = patch.description;
  if (patch.headUserId !== undefined) columns.headUserId = patch.headUserId;
  if (patch.parentDepartmentId !== undefined) {
    columns.parentDepartmentId = patch.parentDepartmentId;
  }
  if (patch.rootFolderId !== undefined) columns.rootFolderId = patch.rootFolderId;
  if (patch.storageQuotaBytes !== undefined) columns.storageQuotaBytes = patch.storageQuotaBytes;
  if (patch.storageUsedBytes !== undefined) columns.storageUsedBytes = patch.storageUsedBytes;
  if (patch.memberCount !== undefined) columns.memberCount = patch.memberCount;
  if (patch.isActive !== undefined) columns.isActive = patch.isActive;

  return columns;
}

export async function updateById(
  id: string,
  patch: DepartmentPatch,
): Promise<DepartmentRecord | null> {
  if (!id) return null;
  const columns = toColumns(patch);
  if (Object.keys(columns).length === 0) return findById(id);

  const db = await getD1();
  const updated = await db
    .update(departments)
    .set({ ...columns, updatedAt: nowIso() })
    .where(eq(departments.id, id))
    .returning({ id: departments.id });

  if (updated.length === 0) return null;
  return findById(id);
}

export async function softDelete(id: string, deletedBy: string): Promise<boolean> {
  if (!id) return false;
  const db = await getD1();
  const now = nowIso();
  const updated = await db
    .update(departments)
    .set({ deletedAt: now, deletedBy, isActive: false, updatedAt: now })
    .where(eq(departments.id, id))
    .returning({ id: departments.id });
  return updated.length > 0;
}

/** Recomputes member counts from the users table — the counter is derived, never authoritative. */
export async function refreshMemberCount(departmentId: string): Promise<number> {
  if (!departmentId) return 0;
  const db = await getD1();

  const rows = await db
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.departmentId, departmentId), eq(users.status, 'active')));

  const total = rows[0]?.value ?? 0;

  await db
    .update(departments)
    .set({ memberCount: total, updatedAt: nowIso() })
    .where(eq(departments.id, departmentId));

  return total;
}

export const d1DepartmentRepository: DepartmentRepository = {
  list,
  findById,
  findByIds,
  findByCode,
  create,
  updateById,
  softDelete,
  refreshMemberCount,
};
