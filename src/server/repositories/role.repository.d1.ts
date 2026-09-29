/**
 * The D1 role and role-grant repository.
 *
 * This is the module that decides who can do what, so it is worth being explicit about the
 * three things it does *not* do.
 *
 * ── 1. It does not filter soft-deleted roles ────────────────────────────────────────────
 *
 * `role.model.ts` includes `softDeleteFields` but never calls `applySoftDeleteFilter`, so a
 * soft-deleted role is still returned by `listRoles` **and still confers its permissions
 * through `getActorGrants`** in MongoDB today. Adding `deleted_at IS NULL` here would revoke
 * live permissions the instant the flag flipped — a silent, organization-wide access change
 * disguised as a clean-up. If that behaviour is wrong it is wrong in both databases and is a
 * product decision, not a migration one.
 *
 * ── 2. It does not merge the two grant listings ─────────────────────────────────────────
 *
 * `getActorGrants` excludes expired grants; `listGrantsForUser` includes them. See the
 * contract.
 *
 * ── 3. It does not drop the "grant with no role" guard ──────────────────────────────────
 *
 * `user_roles.role_id` carries a foreign key, so in D1 a grant cannot outlive its role and
 * the guard is unreachable. It is kept anyway: it is a fail-closed branch on the permission
 * path, and the cost of keeping an unreachable safety check is nothing next to the cost of
 * discovering the constraint was dropped in a later migration.
 */
import { and, asc, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { inList } from '@/server/db/d1-bindings';
import type { Database } from '@/server/db/d1';
import { getD1 } from '@/server/db/d1-context';
import { roles, rolePermissions, roleScopeTypes, userRoles } from '@/server/db/schema/access';
import type { ConfidentialityLevel, Permission, ScopeType } from '@/server/domain/permissions';
import type { RoleGrant } from '@/server/permissions/actor';
import {
  assertScopeShape,
  type GrantRoleInput,
  type GrantSummary,
  type RoleRecord,
  type RoleRepository,
} from './role.repository.contract';

type RoleRow = typeof roles.$inferSelect;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Rebuilds `permissions[]` and `scopeTypes[]` for a set of roles in two queries.
 *
 * These are the arrays every permission check reads, so the cost of getting them per-role
 * would land on `getActorGrants` — which runs on every authenticated request.
 */
async function hydrateRoles(db: Database, rows: RoleRow[]): Promise<RoleRecord[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);

  const [permissionRows, scopeRows] = await Promise.all([
    db
      .select({ roleId: rolePermissions.roleId, key: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(inList(rolePermissions.roleId, ids))
      .orderBy(asc(rolePermissions.permissionKey)),
    db
      .select({ roleId: roleScopeTypes.roleId, scopeType: roleScopeTypes.scopeType })
      .from(roleScopeTypes)
      .where(inList(roleScopeTypes.roleId, ids))
      .orderBy(asc(roleScopeTypes.scopeType)),
  ]);

  const permissionsByRole = new Map<string, Permission[]>();
  for (const row of permissionRows) {
    if (!row.key) continue;
    const list = permissionsByRole.get(row.roleId);
    if (list) list.push(row.key as Permission);
    else permissionsByRole.set(row.roleId, [row.key as Permission]);
  }

  const scopesByRole = new Map<string, ScopeType[]>();
  for (const row of scopeRows) {
    if (!row.scopeType) continue;
    const list = scopesByRole.get(row.roleId);
    if (list) list.push(row.scopeType as ScopeType);
    else scopesByRole.set(row.roleId, [row.scopeType as ScopeType]);
  }

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    key: row.key,
    name: row.name,
    description: row.description ?? '',
    permissions: permissionsByRole.get(row.id) ?? [],
    scopeTypes: scopesByRole.get(row.id) ?? [],
    rank: row.rank,
    maxConfidentiality: (row.maxConfidentiality ?? 'internal') as ConfidentialityLevel,
    companyWideRead: Boolean(row.companyWideRead),
    isSystem: Boolean(row.isSystem),
  }));
}

/* ------------------------------------------------------------------ roles */

export async function listRoles(organizationId: string): Promise<RoleRecord[]> {
  if (!organizationId) return [];
  const db = await getD1();
  const rows = await db
    .select()
    .from(roles)
    .where(eq(roles.organizationId, organizationId))
    .orderBy(desc(roles.rank));
  return hydrateRoles(db, rows);
}

export async function findRoleById(id: string): Promise<RoleRecord | null> {
  if (!id) return null;
  const db = await getD1();
  const [row] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  if (!row) return null;
  const [record] = await hydrateRoles(db, [row]);
  return record ?? null;
}

export async function findRolesByIds(ids: string[]): Promise<RoleRecord[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await getD1();
  const rows = await db.select().from(roles).where(inList(roles.id, unique));
  return hydrateRoles(db, rows);
}

export async function findRoleByKey(
  organizationId: string,
  key: string,
): Promise<RoleRecord | null> {
  if (!organizationId) return null;
  const db = await getD1();
  const [row] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.organizationId, organizationId), eq(roles.key, key.toLowerCase())))
    .limit(1);
  if (!row) return null;
  const [record] = await hydrateRoles(db, [row]);
  return record ?? null;
}

/* ------------------------------------------------------------------ grants */

/**
 * The hot path — every authenticated request.
 *
 * `expires_at > now` compares ISO-8601 strings, which is exactly why Phase 2 chose that format
 * over an epoch integer: the lexicographic comparison and the chronological one are the same
 * comparison, so no conversion is needed on either side of the predicate.
 */
export async function getActorGrants(userId: string): Promise<RoleGrant[]> {
  if (!userId) return [];
  const db = await getD1();

  const grants = await db
    .select()
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, userId),
        isNull(userRoles.revokedAt),
        or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > ${nowIso()}`),
      ),
    );

  if (grants.length === 0) return [];

  const roleIds = [...new Set(grants.map((grant) => grant.roleId))];
  const roleRows = await db.select().from(roles).where(inList(roles.id, roleIds));
  const records = await hydrateRoles(db, roleRows);
  const roleById = new Map(records.map((role) => [role.id, role]));

  const resolved: RoleGrant[] = [];
  for (const grant of grants) {
    const role = roleById.get(grant.roleId);
    // A grant pointing at a deleted role confers nothing — fail closed.
    if (!role) continue;
    resolved.push({
      roleId: role.id,
      roleKey: role.key,
      roleName: role.name,
      rank: role.rank,
      scopeType: grant.scopeType as ScopeType,
      scopeId: grant.scopeId ?? null,
      permissions: role.permissions,
      maxConfidentiality: role.maxConfidentiality,
      companyWideRead: role.companyWideRead,
    });
  }
  return resolved;
}

export async function grantRole(input: GrantRoleInput): Promise<string> {
  // The D1 table has no CHECK for this; MongoDB enforces it with a pre-validate hook. Both
  // repositories call the same assertion so neither database can hold a malformed grant.
  assertScopeShape(input.scopeType, input.scopeId);

  const db = await getD1();
  const id = crypto.randomUUID();
  const now = nowIso();

  await db.insert(userRoles).values({
    id,
    organizationId: input.organizationId,
    userId: input.userId,
    roleId: input.roleId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    grantedBy: input.grantedBy,
    grantedAt: now,
    expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

/**
 * `WHERE … AND revoked_at IS NULL` rather than a read-then-write.
 *
 * It reproduces Mongo's `modifiedCount > 0` — revoking an already-revoked grant returns
 * `false` — and it does so without a window in which two administrators both see an active
 * grant and both record themselves as the one who revoked it.
 */
export async function revokeGrant(grantId: string, revokedBy: string): Promise<boolean> {
  if (!grantId) return false;
  const db = await getD1();
  const now = nowIso();

  const updated = await db
    .update(userRoles)
    .set({ revokedAt: now, revokedBy, updatedAt: now })
    .where(and(eq(userRoles.id, grantId), isNull(userRoles.revokedAt)))
    .returning({ id: userRoles.id });

  return updated.length > 0;
}

/** The administrative view: revoked grants are hidden, **expired ones are not**. */
export async function listGrantsForUser(userId: string): Promise<GrantSummary[]> {
  if (!userId) return [];
  const db = await getD1();

  const grants = await db
    .select()
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), isNull(userRoles.revokedAt)))
    .orderBy(desc(userRoles.grantedAt));

  if (grants.length === 0) return [];

  const roleIds = [...new Set(grants.map((grant) => grant.roleId))];
  const roleRows = await db.select().from(roles).where(inList(roles.id, roleIds));
  const records = await hydrateRoles(db, roleRows);
  const roleById = new Map(records.map((role) => [role.id, role]));

  return grants.flatMap((grant) => {
    const role = roleById.get(grant.roleId);
    if (!role) return [];
    return [
      {
        id: grant.id,
        roleId: role.id,
        roleKey: role.key,
        roleName: role.name,
        rank: role.rank,
        scopeType: grant.scopeType as ScopeType,
        scopeId: grant.scopeId ?? null,
        grantedAt: new Date(grant.grantedAt),
        expiresAt: grant.expiresAt ? new Date(grant.expiresAt) : null,
      },
    ];
  });
}

export async function findActiveGrant(
  userId: string,
  roleId: string,
  scopeType: ScopeType,
  scopeId: string | null,
): Promise<string | null> {
  if (!userId || !roleId) return null;
  const db = await getD1();

  const predicates: SQL[] = [
    eq(userRoles.userId, userId),
    eq(userRoles.roleId, roleId),
    eq(userRoles.scopeType, scopeType),
    isNull(userRoles.revokedAt),
    // `= NULL` is never true in SQL, so a company-scope lookup needs `IS NULL` explicitly.
    scopeId === null ? isNull(userRoles.scopeId) : eq(userRoles.scopeId, scopeId),
  ];

  const [row] = await db
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(and(...predicates))
    .limit(1);

  return row?.id ?? null;
}

export const d1RoleRepository: RoleRepository = {
  listRoles,
  findRoleById,
  findRolesByIds,
  findRoleByKey,
  getActorGrants,
  grantRole,
  revokeGrant,
  listGrantsForUser,
  findActiveGrant,
};
