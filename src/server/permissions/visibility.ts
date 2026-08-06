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
  const principalIds = actorPrincipalIds(actor);
  const denyGuard = aclDenyGuard(principalIds);

  if (actor.isSuperAdmin || actorHasCompanyWideRead(actor)) {
    // Company-wide readers still cannot see beyond their clearance, and `restricted`
    // is never covered by clearance alone. The deny guard applies to them too — see below.
    return {
      $and: [base, denyGuard, { confidentiality: { $in: allowedConfidentialities(actor) } }],
    };
  }

  const userId = toObjectId(actor.userId);
  const departmentId = actor.departmentId ? toObjectId(actor.departmentId) : null;
  const projectIds = actor.projectIds.map(toObjectId).filter((id): id is Types.ObjectId => id !== null);

  const clearance = allowedConfidentialities(actor);

  const branches: VisibilityFilter[] = [
    // Your own content, at any classification.
    ...(userId ? [{ ownerId: userId }] : []),
    // Anything explicitly shared with you, your department, a project, or one of your roles.
    ...(principalIds.length ? [aclAllowBranch(principalIds)] : []),
    // Your department's content, within clearance.
    ...(departmentId ? [{ departmentId, confidentiality: { $in: clearance } }] : []),
    // Your projects' content, within clearance.
    ...(projectIds.length ? [{ projectId: { $in: projectIds }, confidentiality: { $in: clearance } }] : []),
  ];

  // An actor with no department, no projects and no shares sees nothing but their own
  // files — expressed explicitly so the query can never degenerate into "match all".
  if (branches.length === 0) return { ...base, _id: { $in: [] } };

  return { $and: [base, denyGuard, { $or: branches }] };
}

/**
 * Role-scope branches — the department, project and folder grants `roleScopeGrants()` honours.
 *
 * The MongoDB half of `roleScopeBranches` in `visibility.d1.ts`; the two are kept in step by
 * the folder repository suites, which run the same scenarios against both engines.
 */
function roleScopeBranches(actor: Actor): VisibilityFilter[] {
  const branches: VisibilityFilter[] = [];

  const departmentScopes = grantScopeObjectIds(actor, 'department');
  if (departmentScopes.length) branches.push({ departmentId: { $in: departmentScopes } });

  const projectScopes = grantScopeObjectIds(actor, 'project');
  if (projectScopes.length) branches.push({ projectId: { $in: projectScopes } });

  const folderScopes = grantScopeObjectIds(actor, 'folder');
  if (folderScopes.length) {
    // The folder itself, or anything beneath it.
    branches.push({ $or: [{ _id: { $in: folderScopes } }, { pathAncestors: { $in: folderScopes } }] });
  }

  return branches;
}

/**
 * "May this actor be shown this **one** resource?" — the filter behind a permission-aware
 * `findById`.
 *
 * Deliberately a **superset of `canAccess`'s allow set**, and deliberately different from
 * `resourceVisibilityFilter` for that reason: a listing may be narrower than the permission
 * layer (the cost is a row missing from a search page), but a lookup may not, because a
 * repository returning `null` becomes a 404 on a folder the actor is entitled to open. The
 * three cases `resourceVisibilityFilter` would wrongly hide are a role-scoped grant on another
 * department, a folder-scoped grant, and a company-wide reader's own content classified above
 * their clearance.
 *
 * What it does **not** relax is organization isolation and the live deny guard, which are
 * AND-ed over everything, super admins included. `assertCan` still makes the real decision
 * afterwards with the full ancestor chain; this is the half that runs inside the query, so a
 * guessed id never loads a row.
 *
 * The full reasoning lives on `lookupVisibility()` in `visibility.d1.ts`.
 */
export function resourceLookupFilter(actor: Actor): VisibilityFilter {
  const organizationId = toObjectId(actor.organizationId);
  const principalIds = actorPrincipalIds(actor);
  const denyGuard = aclDenyGuard(principalIds);
  const clearance = allowedConfidentialities(actor);

  const userId = toObjectId(actor.userId);
  const branches: VisibilityFilter[] = [
    ...(userId ? [{ ownerId: userId }] : []),
    ...(principalIds.length ? [aclAllowBranch(principalIds)] : []),
  ];

  if (actor.isSuperAdmin || actorHasCompanyWideRead(actor)) {
    branches.push({ confidentiality: { $in: clearance } });
  } else {
    const departmentId = actor.departmentId ? toObjectId(actor.departmentId) : null;
    const projectIds = actor.projectIds
      .map(toObjectId)
      .filter((id): id is Types.ObjectId => id !== null);
    if (departmentId) branches.push({ departmentId, confidentiality: { $in: clearance } });
    if (projectIds.length) {
      branches.push({ projectId: { $in: projectIds }, confidentiality: { $in: clearance } });
    }
  }

  const scopes = roleScopeBranches(actor);
  if (scopes.length) {
    branches.push({ confidentiality: { $in: clearance }, $or: scopes });
  }

  // Never "match all": an actor with nothing at all gets a filter that matches nothing.
  if (branches.length === 0) return { organizationId, _id: { $in: [] } };

  return { $and: [{ organizationId }, denyGuard, { $or: branches }] };
}

/**
 * Entries that are live *and* name this actor.
 *
 * `aclGrants()` in `authorize.ts` skips an expired entry before it looks at anything else
 * (`if (entry.expiresAt && entry.expiresAt.getTime() <= now) continue`). These fragments
 * reproduce that, so an expired grant confers no visibility and an expired **deny** blocks
 * nothing — capability and visibility agree on when an entry stops existing.
 */
function livePredicate(): VisibilityFilter {
  return { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] };
}

function aclAllowBranch(principalIds: Types.ObjectId[]): VisibilityFilter {
  return {
    permissions: {
      $elemMatch: {
        principalId: { $in: principalIds },
        deny: { $ne: true },
        ...livePredicate(),
      },
    },
  };
}

/**
 * "No live deny naming this actor."
 *
 * ── Security correction, Phase 3 module 4 ───────────────────────────────────────────────
 *
 * Until this change `resourceVisibilityFilter` had **no deny guard at all**, and its ACL
 * branch matched `permissions.principalId` without looking at `deny` or `expiresAt`. Two
 * consequences, both live in production:
 *
 *   • a resource carrying an explicit **denial** naming the actor was *more* visible to them
 *     than to somebody with no entry at all — the deny matched the branch and granted
 *     visibility;
 *   • an **expired** share kept granting visibility indefinitely.
 *
 * `canAccess` still refused the action, so this never let anyone open a file. It did let a
 * restricted filename, its folder path and its existence appear in a search listing and in the
 * result count — which for research data is the disclosure that matters.
 *
 * The earlier plan was to reproduce this in D1 so the Phase 6 comparison would agree. That was
 * the wrong call and has been reversed: a migration is not a reason to carry a confidentiality
 * leak forward. Both engines now implement the corrected rule, Phase 6 compares against the
 * corrected behaviour, and the Mongo tests were updated in the same commit.
 *
 * Applied to super admins and company-wide readers as well, because `canAccess` step 4 (deny)
 * precedes step 5 (super admin): deny beats everything, and visibility must not be laxer than
 * capability.
 */
function aclDenyGuard(principalIds: Types.ObjectId[]): VisibilityFilter {
  if (principalIds.length === 0) return {};
  return {
    permissions: {
      $not: {
        $elemMatch: {
          principalId: { $in: principalIds },
          deny: true,
          ...livePredicate(),
        },
      },
    },
  };
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

  // Shared with `resourceVisibilityFilter` so the two cannot drift. Now also expiry-aware:
  // an expired deny blocks nothing, matching `aclGrants()`.
  const denyGuard = aclDenyGuard(principalIds);

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
    // Expiry-aware from Phase 3 module 4: an expired share used to keep granting visibility.
    ...(principalIds.length ? [aclAllowBranch(principalIds)] : []),
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

function grantScopeObjectIds(
  actor: Actor,
  scopeType: 'department' | 'project' | 'folder',
): Types.ObjectId[] {
  return actor.grants
    .filter((grant) => grant.scopeType === scopeType && grant.scopeId)
    .map((grant) => toObjectId(grant.scopeId as string))
    .filter((id): id is Types.ObjectId => id !== null);
}

/**
 * Directory visibility. Every active employee may see the internal directory (names,
 * emails, departments) — status and quota fields are stripped by the DTO unless the
 * viewer holds `user.manage`.
 *
 * ── Database-neutral, unlike the filters above ──────────────────────────────────────────
 *
 * These two return a plain tenant scope rather than a MongoDB filter fragment, because the
 * user and department repositories moved to D1 in Phase 3 and a `Types.ObjectId` means nothing
 * to a SQL query. The module's guarantee is unchanged and arguably stronger: `organizationId`
 * is a *required, named* field on `ListUsersCriteria` and `ListDepartmentsCriteria`, so a
 * listing that omits the tenant predicate no longer type-checks — where previously it would
 * merely have been an empty filter object nobody noticed.
 *
 * `resourceVisibilityFilter` and the rest stay MongoDB-shaped until their own modules move
 * (folders and files, Phase 3 module 4). Converting them now would change queries that nothing
 * in this phase tests.
 */
export function userDirectoryFilter(actor: Actor): { organizationId: string } {
  return { organizationId: actor.organizationId };
}

export function departmentVisibilityFilter(actor: Actor): { organizationId: string } {
  return { organizationId: actor.organizationId };
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
