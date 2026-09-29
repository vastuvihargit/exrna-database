/**
 * Roles, role grants, and the resource ACLs that used to be arrays on folders and files.
 *
 * This is the group where a sloppy migration grants somebody access nobody granted, so every
 * decision here is made by code that is also used elsewhere and tested elsewhere:
 * `resolveEntries()` from `permissions/acl-normalization.ts` — the same function
 * `scripts/validate-acl-uniqueness.ts` prints a preview with, so the report a human reviews
 * before the cutover and the value the migration writes come from one place.
 */
import { FileModel, FolderModel, RoleModel, UserRoleModel } from '@/server/db/models';
import {
  ACCESS_LEVELS,
  CONFIDENTIALITY_LEVELS,
  PERMISSIONS,
  PRINCIPAL_TYPES,
  SCOPE_TYPES,
} from '@/server/domain/permissions';
import { resolveEntries, type AclEntryLike } from '@/server/permissions/acl-normalization';
import {
  bool,
  derivedId,
  enumValue,
  iso,
  nullableEnum,
  num,
  oid,
  requiredIso,
  requiredOid,
  str,
} from '../convert';
import { deleteWhere, insert, upsert } from '../sql';
import { modelStep } from '../step-helpers';
import type { MigrationStep, SourceDocument, Statement, StepContext } from '../types';
import { timestamps } from './identity';

export const rolesStep: MigrationStep = modelStep({
  name: 'roles',
  description: 'Roles, their permissions and their scope types',
  targets: ['roles', 'role_permissions', 'role_scope_types'],
  requires: ['organizations', 'users'],
  publishes: 'roles',
  model: RoleModel as never,
  withDeleted: true,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'roles._id');
    const organizationId = requiredOid(document.organizationId, 'roles.organizationId');
    if (!context.known.get('organizations')?.has(organizationId)) {
      return { kind: 'skip', reason: `organization ${organizationId} was not migrated` };
    }
    const createdBy = oid(document.createdBy);

    const statements: Statement[] = [
      upsert('roles', {
        id,
        organization_id: organizationId,
        key: str(document.key),
        name: str(document.name),
        description: str(document.description),
        rank: num(document.rank),
        max_confidentiality: enumValue(
          document.maxConfidentiality,
          CONFIDENTIALITY_LEVELS,
          'internal',
        ),
        company_wide_read: bool(document.companyWideRead),
        is_system: bool(document.isSystem),
        created_by: createdBy && context.known.get('users')?.has(createdBy) ? createdBy : null,
        ...timestamps(document),
        deleted_at: iso(document.deletedAt),
        deleted_by: oid(document.deletedBy),
      }),
      deleteWhere('role_permissions', { role_id: id }),
      deleteWhere('role_scope_types', { role_id: id }),
    ];

    /**
     * `role_permissions.permission_key` is a foreign key into the `permissions` catalogue that
     * migration 0001 seeds. A permission string in MongoDB that is not in the catalogue — a
     * capability that was renamed, or removed in a later release without a data fix-up — would
     * abort the batch. Dropping it is the only option that does not lose 499 unrelated records,
     * and it fails *closed*: the role ends up with fewer capabilities, never more.
     */
    const permissions = Array.isArray(document.permissions) ? document.permissions : [];
    for (const permission of new Set(permissions.map(String))) {
      if (!(PERMISSIONS as readonly string[]).includes(permission)) continue;
      statements.push(insert('role_permissions', { role_id: id, permission_key: permission }));
    }

    const scopeTypes = Array.isArray(document.scopeTypes) ? document.scopeTypes : [];
    for (const scopeType of new Set(scopeTypes.map(String))) {
      if (!(SCOPE_TYPES as readonly string[]).includes(scopeType)) continue;
      statements.push(insert('role_scope_types', { role_id: id, scope_type: scopeType }));
    }

    return { kind: 'write', statements };
  },
});

/**
 * Role grants.
 *
 * Migration 0003 put the scope invariant in the database: a company-scope grant carries no
 * `scope_id`, every other scope requires one, and `''` is forbidden because migration 0002's
 * unique index uses it as the sentinel for company scope. A grant that violates it is skipped
 * with the reason rather than being "fixed" — inventing a scope id, or promoting a
 * department-scope grant to company scope, would grant access nobody granted.
 */
export const userRolesStep: MigrationStep = modelStep({
  name: 'user-roles',
  description: 'Role grants',
  targets: ['user_roles'],
  requires: ['roles', 'users'],
  model: UserRoleModel as never,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'user_roles._id');
    const organizationId = requiredOid(document.organizationId, 'user_roles.organizationId');
    const userId = requiredOid(document.userId, 'user_roles.userId');
    const roleId = requiredOid(document.roleId, 'user_roles.roleId');

    if (!context.known.get('users')?.has(userId)) {
      return { kind: 'skip', reason: `user ${userId} was not migrated` };
    }
    if (!context.known.get('roles')?.has(roleId)) {
      return { kind: 'skip', reason: `role ${roleId} was not migrated` };
    }

    const scopeType = str(document.scopeType);
    if (!(SCOPE_TYPES as readonly string[]).includes(scopeType)) {
      return { kind: 'skip', reason: `scope type "${scopeType}" is not a valid scope` };
    }
    const scopeId = oid(document.scopeId);
    if (scopeType === 'company' && scopeId !== null) {
      return { kind: 'skip', reason: 'a company-scope grant must not carry a scope id' };
    }
    if (scopeType !== 'company' && (scopeId === null || scopeId === '')) {
      return { kind: 'skip', reason: `a ${scopeType}-scope grant requires a scope id` };
    }

    const grantedBy = oid(document.grantedBy);
    const revokedBy = oid(document.revokedBy);
    const knownUsers = context.known.get('users');

    return {
      kind: 'write',
      statements: [
        upsert('user_roles', {
          id,
          organization_id: organizationId,
          user_id: userId,
          role_id: roleId,
          scope_type: scopeType,
          scope_id: scopeId,
          granted_by: grantedBy && knownUsers?.has(grantedBy) ? grantedBy : null,
          granted_at: requiredIso(document.grantedAt, requiredIso(document.createdAt, new Date(0).toISOString())),
          expires_at: iso(document.expiresAt),
          revoked_at: iso(document.revokedAt),
          revoked_by: revokedBy && knownUsers?.has(revokedBy) ? revokedBy : null,
          ...timestamps(document),
        }),
      ],
    };
  },
});

/* ------------------------------------------------------------------ resource ACLs */

/**
 * `folders.permissions[]` / `files.permissions[]` → `resource_permissions`.
 *
 * ── Why this cannot be a straight copy ──────────────────────────────────────────────────
 *
 * MongoDB's embedded array permits a principal to hold several entries on one resource. D1
 * constrains `ux_resource_permissions` to one per principal per resource. Copying the array
 * would either abort on the unique index or, if written to tolerate that, keep whichever entry
 * happened to come first — and if the entry it dropped was a **denial**, the migration grants
 * access that nobody granted and no audit record explains.
 *
 * `resolveEntries()` decides, in this order: expired entries contribute nothing; a live denial
 * beats every allow; otherwise the strongest live allow wins; if nothing is live the principal
 * gets no entry at all. `scripts/validate-acl-uniqueness.ts` prints exactly this resolution
 * before the cutover, so nothing here is decided for the first time during the migration.
 *
 * `now` comes from the run context rather than being read per record, so a long run resolves
 * every expiry against one instant. Otherwise a grant expiring during the migration would be
 * live for the folders read before it and expired for the files read after — a corpus in which
 * one principal's access depends on read order.
 */
function aclStatements(
  resourceType: 'folder' | 'file',
  resourceId: string,
  organizationId: string,
  raw: unknown,
  context: StepContext,
): Statement[] {
  const statements: Statement[] = [
    deleteWhere('resource_permissions', {
      resource_type: resourceType,
      resource_id: resourceId,
    }),
  ];

  if (!Array.isArray(raw) || raw.length === 0) return statements;

  const byPrincipal = new Map<string, AclEntryLike[]>();
  for (const item of raw) {
    const entry = item as Record<string, unknown>;
    const principalType = str(entry.principalType);
    const principalId = oid(entry.principalId);
    if (principalId === null) continue;
    if (!(PRINCIPAL_TYPES as readonly string[]).includes(principalType)) continue;

    const key = `${principalType}:${principalId}`;
    const list = byPrincipal.get(key) ?? [];
    list.push({
      principalType,
      principalId,
      accessLevel: str(entry.accessLevel),
      deny: entry.deny === true,
      expiresAt: entry.expiresAt instanceof Date ? entry.expiresAt : null,
      // Carried through so the winning entry keeps its own provenance rather than the first
      // entry's — who granted this access and when is the part an audit actually reads.
      ...(entry.grantedBy !== undefined ? { grantedBy: entry.grantedBy } : {}),
      ...(entry.grantedAt !== undefined ? { grantedAt: entry.grantedAt } : {}),
    } as AclEntryLike);
    byPrincipal.set(key, list);
  }

  for (const [key, entries] of byPrincipal) {
    const resolved = resolveEntries(entries, context.now);
    // Null means every entry for this principal has expired. They get no row: an expired grant
    // that is copied as a live one is the migration granting access.
    if (!resolved) continue;

    const withProvenance = resolved as AclEntryLike & { grantedBy?: unknown; grantedAt?: unknown };
    const accessLevel = enumValue(resolved.accessLevel, ACCESS_LEVELS, 'viewer');

    statements.push(
      insert('resource_permissions', {
        id: derivedId('rp_', resourceType, resourceId, key),
        organization_id: organizationId,
        resource_type: resourceType,
        resource_id: resourceId,
        principal_type: resolved.principalType,
        principal_id: resolved.principalId,
        access_level: accessLevel,
        deny: bool(resolved.deny),
        expires_at: resolved.expiresAt ? resolved.expiresAt.toISOString() : null,
        granted_by: oid(withProvenance.grantedBy),
        granted_at: requiredIso(withProvenance.grantedAt, new Date(context.now).toISOString()),
      }),
    );
  }

  return statements;
}

function aclStep(
  name: string,
  resourceType: 'folder' | 'file',
  model: unknown,
  requires: string[],
): MigrationStep {
  return modelStep({
    name,
    description: `ACL entries on ${resourceType}s`,
    targets: ['resource_permissions'],
    requires,
    model: model as never,
    withDeleted: true,
    // Only the fields the ACL needs. A folder document is large and there are a lot of them.
    select: '_id organizationId permissions',
    deltaField: 'updatedAt',
    transform(document: SourceDocument, context) {
      const resourceId = requiredOid(document._id, `${resourceType}._id`);
      const organizationId = requiredOid(
        document.organizationId,
        `${resourceType}.organizationId`,
      );
      return {
        kind: 'write',
        statements: aclStatements(
          resourceType,
          resourceId,
          organizationId,
          document.permissions,
          context,
        ),
      };
    },
  });
}

export const folderAclStep = aclStep('folder-acl', 'folder', FolderModel, ['folders']);
export const fileAclStep = aclStep('file-acl', 'file', FileModel, ['files']);

export { nullableEnum };
