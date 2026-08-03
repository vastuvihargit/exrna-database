/**
 * Query-time visibility filters.
 *
 * The anti-leak mechanism for search and every list endpoint: permission is expressed
 * as part of the MongoDB query, never applied after fetching. Post-filtering leaks
 * through counts, pagination totals and facet numbers even when rows are removed.
 *
 * Repositories require a filter produced here, so it is structurally awkward to write
 * a listing query that forgets it.
 */
import { Types } from 'mongoose';
import { CLEARANCE_BY_MAX_LEVEL, type ConfidentialityLevel } from '@/server/domain/permissions';
import { actorClearance, actorHasCompanyWideRead, type Actor } from './actor';

export type VisibilityFilter = Record<string, unknown>;

function toObjectId(value: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : null;
}

/** Classifications this actor may see without an explicit per-resource grant. */
export function allowedConfidentialities(actor: Actor): ConfidentialityLevel[] {
  return [...CLEARANCE_BY_MAX_LEVEL[actorClearance(actor)]];
}

/**
 * Filter fragment for resources that carry departmentId / projectId / ownerId / acl.
 * Used by folders and files from Phase 3 onward; exported now so the contract is fixed
 * before there are call sites to retrofit.
 */
export function resourceVisibilityFilter(actor: Actor): VisibilityFilter {
  const organizationId = toObjectId(actor.organizationId);
  const base: VisibilityFilter = { organizationId };

  if (actor.isSuperAdmin || actorHasCompanyWideRead(actor)) {
    // Company-wide readers still cannot see beyond their clearance, and `restricted`
    // is never covered by clearance alone.
    return { ...base, confidentiality: { $in: allowedConfidentialities(actor) } };
  }

  const userId = toObjectId(actor.userId);
  const departmentId = actor.departmentId ? toObjectId(actor.departmentId) : null;
  const projectIds = actor.projectIds.map(toObjectId).filter((id): id is Types.ObjectId => id !== null);
  const roleIds = actor.grants.map((grant) => toObjectId(grant.roleId)).filter((id): id is Types.ObjectId => id !== null);

  const principalIds = [userId, departmentId, ...projectIds, ...roleIds].filter(
    (id): id is Types.ObjectId => id !== null,
  );

  const clearance = allowedConfidentialities(actor);

  const branches: VisibilityFilter[] = [
    // Your own content, at any classification.
    ...(userId ? [{ ownerId: userId }] : []),
    // Anything explicitly shared with you, your department, a project, or one of your roles.
    ...(principalIds.length ? [{ 'permissions.principalId': { $in: principalIds } }] : []),
    // Your department's content, within clearance.
    ...(departmentId ? [{ departmentId, confidentiality: { $in: clearance } }] : []),
    // Your projects' content, within clearance.
    ...(projectIds.length ? [{ projectId: { $in: projectIds }, confidentiality: { $in: clearance } }] : []),
  ];

  // An actor with no department, no projects and no shares sees nothing but their own
  // files — expressed explicitly so the query can never degenerate into "match all".
  if (branches.length === 0) return { ...base, _id: { $in: [] } };

  return { ...base, $or: branches };
}

/**
 * Visibility of the children of a folder the actor is *already* authorized to open.
 *
 * Different from `resourceVisibilityFilter`, which answers "can this actor reach this
 * resource from nothing". Here the parent has already been authorized, so inheritance
 * is the normal case and the query only has to express the exceptions:
 *   • an explicit deny matching the actor — beats everything, super admin included
 *   • a child that has broken inheritance and grants the actor nothing directly
 *   • a child classified above the actor's clearance, unless they own it or hold a
 *     direct grant on it
 *
 * Expressing this in the query rather than after the fetch keeps `total` honest: a
 * count that includes rows the user cannot see is itself a disclosure.
 */
export function childVisibilityFilter(actor: Actor): VisibilityFilter {
  const principalIds = actorPrincipalIds(actor);

  const denyGuard: VisibilityFilter =
    principalIds.length > 0
      ? { permissions: { $not: { $elemMatch: { principalId: { $in: principalIds }, deny: true } } } }
      : {};

  const clearance = allowedConfidentialities(actor);

  if (actor.isSuperAdmin || actorHasCompanyWideRead(actor)) {
    return { $and: [denyGuard, { confidentiality: { $in: clearance } }] };
  }

  const userId = toObjectId(actor.userId);
  const departmentScopeIds = grantScopeObjectIds(actor, 'department');
  const projectScopeIds = grantScopeObjectIds(actor, 'project');

  const scopeBranches: VisibilityFilter[] = [{ inheritPermissions: { $ne: false } }];
  if (departmentScopeIds.length) scopeBranches.push({ departmentId: { $in: departmentScopeIds } });
  if (projectScopeIds.length) scopeBranches.push({ projectId: { $in: projectScopeIds } });

  const branches: VisibilityFilter[] = [
    // Owner and direct grantee are not subject to the clearance gate — they were given
    // the resource explicitly (docs/phase-0/05, resolution steps 6–8).
    ...(userId ? [{ ownerId: userId }] : []),
    ...(principalIds.length ? [{ 'permissions.principalId': { $in: principalIds } }] : []),
    { confidentiality: { $in: clearance }, $or: scopeBranches },
  ];

  return { $and: [denyGuard, { $or: branches }] };
}

function actorPrincipalIds(actor: Actor): Types.ObjectId[] {
  const ids = [
    toObjectId(actor.userId),
    actor.departmentId ? toObjectId(actor.departmentId) : null,
    ...actor.projectIds.map(toObjectId),
    ...actor.grants.map((grant) => toObjectId(grant.roleId)),
  ];
  return ids.filter((id): id is Types.ObjectId => id !== null);
}

function grantScopeObjectIds(actor: Actor, scopeType: 'department' | 'project'): Types.ObjectId[] {
  return actor.grants
    .filter((grant) => grant.scopeType === scopeType && grant.scopeId)
    .map((grant) => toObjectId(grant.scopeId as string))
    .filter((id): id is Types.ObjectId => id !== null);
}

/**
 * Directory visibility. Every active employee may see the internal directory (names,
 * emails, departments) — status and quota fields are stripped by the DTO unless the
 * viewer holds `user.manage`.
 */
export function userDirectoryFilter(actor: Actor): VisibilityFilter {
  return { organizationId: toObjectId(actor.organizationId) };
}

export function departmentVisibilityFilter(actor: Actor): VisibilityFilter {
  return { organizationId: toObjectId(actor.organizationId) };
}

/**
 * Inventory visibility: the whole organization, for anyone holding `inventory.view`.
 *
 * Stated as a filter rather than left implicit so that inventory listings keep the property
 * every other listing in this application has — permission is part of the query, never a
 * post-filter — and so that the reasoning is written down somewhere rather than inferred
 * from an absence.
 *
 * The reasoning: an inventory item has no owner, no ACL and no confidentiality
 * classification. What is on the shelf is operational information in the same category as
 * the department list and the employee directory, both of which are already organization-
 * wide (`departmentVisibilityFilter`, `userDirectoryFilter`). Narrowing it to the reader's
 * own department would mean a scientist could not find out that the reagent they need is
 * sitting in the store two floors down, which is the question the module exists to answer.
 *
 * *Changing* stock is scoped, and that is enforced separately by
 * `assertInventoryPermission` — see src/server/services/inventory-access.ts.
 */
export function inventoryVisibilityFilter(actor: Actor): VisibilityFilter {
  return { organizationId: toObjectId(actor.organizationId) };
}
