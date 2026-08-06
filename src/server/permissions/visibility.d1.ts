/**
 * Visibility predicates for D1, built from the same `Actor` as the MongoDB filters.
 *
 * Companion to `visibility.ts`, not a translation of it. The two are kept in step by
 * `06-phase-3-module-4-acl-design.md` and by tests that run the same scenarios against both
 * engines; where they differ, the test fails.
 *
 * ── Rules this file exists to enforce ───────────────────────────────────────────────────
 *
 *   • a live explicit denial naming the actor removes the row, ahead of everything else —
 *     ownership, direct grant, inheritance, department, project, role, super admin;
 *   • an expired entry grants nothing and denies nothing (`aclGrants()` skips it entirely);
 *   • the predicate is applied **inside** the query, to rows *and* to counts, so `total` and
 *     pagination cannot disclose a row the actor may not see;
 *   • the predicate can never degenerate into "match all".
 *
 * ── Parameterisation ────────────────────────────────────────────────────────────────────
 *
 * Every id reaches SQL as a bound parameter. `sql` template interpolation of a value produces
 * a placeholder in Drizzle — the only place `sql.raw` appears in this module is for the
 * literal table name of the ACL sub-select, which is a constant in this file and never
 * caller-supplied.
 */
import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { resourcePermissions } from '@/server/db/schema/access';
import { folders, files } from '@/server/db/schema/drive';
import { AppError } from '@/server/errors/app-error';
import { actorClearance, actorHasCompanyWideRead, type Actor } from './actor';
import { CLEARANCE_BY_MAX_LEVEL, type ConfidentialityLevel } from '@/server/domain/permissions';
import { getLogger } from '@/server/logging/logger';

/* ------------------------------------------------------------------ principals */

/**
 * How many principals one actor may carry into a visibility query.
 *
 * A principal is the actor, their department, each project they belong to, and **each role
 * they hold** — so the list grows with role grants and has no natural ceiling. It is bound
 * into an `IN (...)` list inside two correlated sub-queries per listing; SQLite's default
 * `SQLITE_MAX_VARIABLE_NUMBER` is 999 and D1 rejects statements with too many bindings, so an
 * unbounded list turns a permission check into a query failure at an unpredictable size.
 *
 * 200 is far above anything legitimate — the seeded role set is single digits, and an employee
 * on 200 projects is a data problem rather than a person — while staying well inside the
 * binding budget once the other predicates are counted.
 */
export const MAX_ACTOR_PRINCIPALS = 200;

/**
 * Raised when an actor carries more principals than the query can safely bind.
 *
 * **Fails closed.** The alternative — truncating the list — would silently drop roles or
 * project memberships and produce a *narrower* result set that looks like a working page,
 * so a user would quietly stop seeing files they are entitled to and nobody would know why.
 * A visible error is recoverable; a silent permission change is not.
 */
export class TooManyPrincipalsError extends AppError {
  constructor(count: number) {
    super(
      'INTERNAL_ERROR',
      // Deliberately says nothing about roles or projects to the browser: this is a server
      // condition, and the operator detail goes to the log line above, not to the user.
      'This account could not be checked for access. Please contact an administrator.',
      500,
      { details: { principalCount: count, limit: MAX_ACTOR_PRINCIPALS } },
    );
  }
}

/**
 * The ids an ACL entry may name to reach this actor: themselves, their department, their
 * projects, and every role they hold.
 *
 * Role ids are included deliberately — a share targeted at a role is invisible without them,
 * and omitting them would silently revoke every role-targeted share in the system.
 */
export function actorPrincipalIds(actor: Actor): string[] {
  const ids = [
    actor.userId,
    actor.departmentId,
    ...actor.projectIds,
    ...actor.grants.map((grant) => grant.roleId),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);

  const unique = [...new Set(ids)];

  if (unique.length > MAX_ACTOR_PRINCIPALS) {
    getLogger().error(
      { userId: actor.userId, principalCount: unique.length, limit: MAX_ACTOR_PRINCIPALS },
      'Actor principal set exceeds the safe query limit; refusing rather than truncating',
    );
    throw new TooManyPrincipalsError(unique.length);
  }

  return unique;
}

/* ------------------------------------------------------------------ shared shapes */

export type ResourceKind = 'folder' | 'file';

/** The columns both `folders` and `files` carry, so one predicate builder serves both. */
interface ResourceColumns {
  id: SQLiteColumn;
  organizationId: SQLiteColumn;
  ownerId: SQLiteColumn;
  departmentId: SQLiteColumn;
  projectId: SQLiteColumn;
  confidentiality: SQLiteColumn;
  inheritPermissions: SQLiteColumn;
  deletedAt: SQLiteColumn;
  status: SQLiteColumn;
}

export function columnsFor(kind: ResourceKind): ResourceColumns {
  return kind === 'folder'
    ? {
        id: folders.id,
        organizationId: folders.organizationId,
        ownerId: folders.ownerId,
        departmentId: folders.departmentId,
        projectId: folders.projectId,
        confidentiality: folders.confidentiality,
        inheritPermissions: folders.inheritPermissions,
        deletedAt: folders.deletedAt,
        status: folders.status,
      }
    : {
        id: files.id,
        organizationId: files.organizationId,
        ownerId: files.ownerId,
        departmentId: files.departmentId,
        projectId: files.projectId,
        confidentiality: files.confidentiality,
        inheritPermissions: files.inheritPermissions,
        deletedAt: files.deletedAt,
        status: files.status,
      };
}

/**
 * "This entry is live" — not expired.
 *
 * ISO-8601 text compares chronologically as it compares lexicographically, which is why
 * Phase 2 stored timestamps this way: no conversion is needed on either side.
 */
function liveEntry(nowIso: string): SQL {
  return or(
    isNull(resourcePermissions.expiresAt),
    sql`${resourcePermissions.expiresAt} > ${nowIso}`,
  )!;
}

/**
 * A correlated sub-select over `resource_permissions` for one resource row.
 *
 * `EXISTS`/`NOT EXISTS` rather than a join: a join against an ACL table multiplies rows, and
 * the `DISTINCT` needed to undo that is a sort the query does not otherwise need — and, worse,
 * a `LEFT JOIN ... IS NULL` formulation of the deny check silently stops working the moment
 * another predicate turns the outer join back into an inner one.
 */
function aclExists(
  kind: ResourceKind,
  resourceId: SQLiteColumn,
  principalIds: string[],
  extra: SQL,
  nowIso: string,
): SQL {
  return sql`EXISTS (SELECT 1 FROM ${resourcePermissions}
    WHERE ${resourcePermissions.resourceType} = ${kind}
      AND ${resourcePermissions.resourceId} = ${resourceId}
      AND ${inArray(resourcePermissions.principalId, principalIds)}
      AND ${liveEntry(nowIso)}
      AND ${extra})`;
}

/** No **live** denial naming this actor. Applies to super admins too — see the design doc §3. */
export function denyGuard(
  kind: ResourceKind,
  principalIds: string[],
  nowIso: string,
): SQL | undefined {
  if (principalIds.length === 0) return undefined;
  const columns = columnsFor(kind);
  return sql`NOT ${aclExists(kind, columns.id, principalIds, sql`${resourcePermissions.deny} = 1`, nowIso)}`;
}

/** A live, non-deny entry naming this actor. */
export function directGrant(
  kind: ResourceKind,
  principalIds: string[],
  nowIso: string,
): SQL | undefined {
  if (principalIds.length === 0) return undefined;
  const columns = columnsFor(kind);
  return aclExists(kind, columns.id, principalIds, sql`${resourcePermissions.deny} = 0`, nowIso);
}

/**
 * A live, non-deny entry on any ancestor folder the resource still inherits from.
 *
 * The ancestor set comes from `folder_ancestors` / `file_folder_ancestors`, which is why
 * Phase 2 made them tables. `inherit_permissions = 0` on the resource itself cuts the walk
 * off entirely, matching `canAccess` step 4.
 *
 * Note this does **not** stop at an intermediate ancestor that breaks inheritance. That
 * refinement belongs to the per-resource `canAccess` decision, which walks leaf → root with
 * the full chain; here it would mean a recursive CTE per row in a listing. The listing is
 * therefore *no narrower* than capability — a row may appear that `canAccess` later refuses,
 * which is the safe direction — and the design doc records it.
 */
export function inheritedGrant(
  kind: ResourceKind,
  principalIds: string[],
  nowIso: string,
): SQL | undefined {
  if (principalIds.length === 0) return undefined;
  const columns = columnsFor(kind);
  const ancestorTable = kind === 'folder' ? sql.raw('folder_ancestors') : sql.raw('file_folder_ancestors');
  const childColumn = kind === 'folder' ? sql.raw('folder_id') : sql.raw('file_id');

  return sql`(${columns.inheritPermissions} = 1 AND EXISTS (
    SELECT 1 FROM ${ancestorTable} anc
      JOIN ${resourcePermissions} ON ${resourcePermissions.resourceType} = 'folder'
                                 AND ${resourcePermissions.resourceId} = anc.ancestor_id
     WHERE anc.${childColumn} = ${columns.id}
       AND ${inArray(resourcePermissions.principalId, principalIds)}
       AND ${liveEntry(nowIso)}
       AND ${resourcePermissions.deny} = 0))`;
}

/** A live denial on an inherited ancestor removes the row, exactly as a direct one does. */
export function inheritedDenyGuard(
  kind: ResourceKind,
  principalIds: string[],
  nowIso: string,
): SQL | undefined {
  if (principalIds.length === 0) return undefined;
  const columns = columnsFor(kind);
  const ancestorTable = kind === 'folder' ? sql.raw('folder_ancestors') : sql.raw('file_folder_ancestors');
  const childColumn = kind === 'folder' ? sql.raw('folder_id') : sql.raw('file_id');

  return sql`NOT (${columns.inheritPermissions} = 1 AND EXISTS (
    SELECT 1 FROM ${ancestorTable} anc
      JOIN ${resourcePermissions} ON ${resourcePermissions.resourceType} = 'folder'
                                 AND ${resourcePermissions.resourceId} = anc.ancestor_id
     WHERE anc.${childColumn} = ${columns.id}
       AND ${inArray(resourcePermissions.principalId, principalIds)}
       AND ${liveEntry(nowIso)}
       AND ${resourcePermissions.deny} = 1))`;
}

export function clearancePredicate(kind: ResourceKind, actor: Actor): SQL {
  const allowed = [...CLEARANCE_BY_MAX_LEVEL[actorClearance(actor)]] as ConfidentialityLevel[];
  return inArray(columnsFor(kind).confidentiality, allowed);
}

/** Soft delete. Both `folder.model.ts` and `file.model.ts` apply the Mongoose hook. */
export function livePredicate(kind: ResourceKind): SQL {
  return isNull(columnsFor(kind).deletedAt);
}

export function trashedPredicate(kind: ResourceKind): SQL {
  return isNotNull(columnsFor(kind).deletedAt);
}

/* ------------------------------------------------------------------ the two filters */

export interface VisibilityOptions {
  /** Defaults to now. Injectable so expiry can be tested without waiting. */
  nowIso?: string;
}

/**
 * "Can this actor reach this resource from nothing" — search and cross-tree lookups.
 *
 * Returns a predicate that is **never** absent: an actor with no department, no projects and
 * no shares gets `1 = 0`, not an omitted WHERE.
 */
export function resourceVisibility(
  kind: ResourceKind,
  actor: Actor,
  options: VisibilityOptions = {},
): SQL {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const columns = columnsFor(kind);
  const principalIds = actorPrincipalIds(actor);

  const guards: SQL[] = [eq(columns.organizationId, actor.organizationId)];
  const deny = denyGuard(kind, principalIds, nowIso);
  if (deny) guards.push(deny);
  const inheritedDeny = inheritedDenyGuard(kind, principalIds, nowIso);
  if (inheritedDeny) guards.push(inheritedDeny);

  if (actor.isSuperAdmin || actorHasCompanyWideRead(actor)) {
    return and(...guards, clearancePredicate(kind, actor))!;
  }

  const branches: SQL[] = [];
  if (actor.userId) branches.push(eq(columns.ownerId, actor.userId));

  const direct = directGrant(kind, principalIds, nowIso);
  if (direct) branches.push(direct);
  const inherited = inheritedGrant(kind, principalIds, nowIso);
  if (inherited) branches.push(inherited);

  const clearance = clearancePredicate(kind, actor);
  if (actor.departmentId) {
    branches.push(and(eq(columns.departmentId, actor.departmentId), clearance)!);
  }
  if (actor.projectIds.length > 0) {
    branches.push(and(inArray(columns.projectId, actor.projectIds), clearance)!);
  }

  // Explicit, so the query can never degenerate into "match all".
  if (branches.length === 0) return sql`1 = 0`;

  return and(...guards, or(...branches)!)!;
}

/**
 * Children of a folder the actor is *already* authorised to open.
 *
 * Inheritance is the normal case here, so the predicate expresses the exceptions: a live
 * denial, a child that broke inheritance and grants nothing directly, and a child classified
 * above clearance unless owned or directly granted.
 */
export function childVisibility(
  kind: ResourceKind,
  actor: Actor,
  options: VisibilityOptions = {},
): SQL {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const columns = columnsFor(kind);
  const principalIds = actorPrincipalIds(actor);

  const guards: SQL[] = [];
  const deny = denyGuard(kind, principalIds, nowIso);
  if (deny) guards.push(deny);
  const inheritedDeny = inheritedDenyGuard(kind, principalIds, nowIso);
  if (inheritedDeny) guards.push(inheritedDeny);

  const clearance = clearancePredicate(kind, actor);

  if (actor.isSuperAdmin || actorHasCompanyWideRead(actor)) {
    return guards.length ? and(...guards, clearance)! : clearance;
  }

  const departmentScopes = scopeIds(actor, 'department');
  const projectScopes = scopeIds(actor, 'project');

  const scopeBranches: SQL[] = [eq(columns.inheritPermissions, true)];
  if (departmentScopes.length) scopeBranches.push(inArray(columns.departmentId, departmentScopes));
  if (projectScopes.length) scopeBranches.push(inArray(columns.projectId, projectScopes));

  const branches: SQL[] = [];
  // Owner and direct grantee bypass the clearance gate — they were given the resource.
  if (actor.userId) branches.push(eq(columns.ownerId, actor.userId));
  const direct = directGrant(kind, principalIds, nowIso);
  if (direct) branches.push(direct);
  branches.push(and(clearance, or(...scopeBranches)!)!);

  return guards.length ? and(...guards, or(...branches)!)! : or(...branches)!;
}

function scopeIds(actor: Actor, scopeType: 'department' | 'project'): string[] {
  return [
    ...new Set(
      actor.grants
        .filter((grant) => grant.scopeType === scopeType && grant.scopeId)
        .map((grant) => grant.scopeId as string),
    ),
  ];
}
