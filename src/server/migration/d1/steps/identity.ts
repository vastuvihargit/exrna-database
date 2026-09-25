/**
 * Organizations, departments, users, application settings.
 *
 * Loaded first because everything else carries an `organization_id` foreign key, and because
 * the two circular references in this group — a department has a head who is a user who belongs
 * to a department — set the pattern the rest of the migration uses: write NULL, back-fill.
 */
import {
  AppSettingModel,
  DepartmentModel,
  OrganizationModel,
  UserModel,
} from '@/server/db/models';
import { AUTH_PROVIDERS, USER_STATUSES } from '@/server/db/models/user.model';
import {
  bool,
  derivedId,
  enumValue,
  iso,
  json,
  jsonArray,
  nullableStr,
  num,
  oid,
  requiredIso,
  requiredOid,
  str,
} from '../convert';
import { deleteWhere, insert, update, upsert } from '../sql';
import { modelStep } from '../step-helpers';
import type { MigrationStep, SourceDocument, Statement } from '../types';

/** Every row carries the source document's own timestamps, never `now`. */
function timestamps(document: SourceDocument): { created_at: string; updated_at: string } {
  const created = requiredIso(document.createdAt, new Date(0).toISOString());
  return { created_at: created, updated_at: requiredIso(document.updatedAt, created) };
}

export const organizationsStep: MigrationStep = modelStep({
  name: 'organizations',
  description: 'Tenant roots',
  targets: ['organizations'],
  requires: [],
  publishes: 'organizations',
  model: OrganizationModel as never,
  withDeleted: true,
  deltaField: 'updatedAt',
  transform(document) {
    const id = requiredOid(document._id, 'organizations._id');
    return {
      kind: 'write',
      statements: [
        upsert('organizations', {
          id,
          name: str(document.name),
          slug: str(document.slug),
          email_domains: jsonArray(document.emailDomains),
          // The settings sub-document moves whole. Nine columns would be nine migrations the
          // first time an admin-configurable option is added; nothing filters on it.
          settings: json(document.settings, '{}'),
          storage_used_bytes: num(document.storageUsedBytes),
          file_count: num(document.fileCount),
          is_active: bool(document.isActive),
          ...timestamps(document),
          deleted_at: iso(document.deletedAt),
          deleted_by: oid(document.deletedBy),
        }),
      ],
    };
  },
});

/**
 * Departments, with every user reference NULL.
 *
 * `head_user_id`, `created_by` and `parent_department_id` are written by `identity-backfill`.
 * The first two point at users who do not exist yet; the third is a self-reference and a
 * department tree can be in any `_id` order.
 */
export const departmentsStep: MigrationStep = modelStep({
  name: 'departments',
  description: 'Departments (user and parent references deferred)',
  targets: ['departments'],
  requires: ['organizations'],
  publishes: 'departments',
  model: DepartmentModel as never,
  withDeleted: true,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'departments._id');
    const organizationId = requiredOid(document.organizationId, 'departments.organizationId');
    if (!context.known.get('organizations')?.has(organizationId)) {
      return { kind: 'skip', reason: `organization ${organizationId} was not migrated` };
    }

    return {
      kind: 'write',
      statements: [
        upsert('departments', {
          id,
          organization_id: organizationId,
          name: str(document.name),
          code: str(document.code),
          description: str(document.description),
          head_user_id: null,
          parent_department_id: null,
          // Not a foreign key in the D1 schema, deliberately — see `identity.ts`. So it can be
          // written now and does not need the folder step to have run.
          root_folder_id: oid(document.rootFolderId),
          storage_quota_bytes: num(document.storageQuotaBytes),
          storage_used_bytes: num(document.storageUsedBytes),
          member_count: num(document.memberCount),
          is_active: bool(document.isActive),
          created_by: null,
          ...timestamps(document),
          deleted_at: iso(document.deletedAt),
          deleted_by: oid(document.deletedBy),
        }),
      ],
    };
  },
});

/**
 * Users, and `users.authProviders[]` as `user_auth_providers`.
 *
 * `projectIds[]` is deliberately **not** migrated. MongoDB kept project membership twice — on
 * the user and on `projects.memberUserIds[]` — and kept them in step from the service layer.
 * D1 has one copy, in `project_members`, written by the projects step. Two copies of one fact is
 * two things that can disagree, and the disagreement is invisible until somebody cannot see a
 * project they are a member of. `schema/identity.ts` records the same decision.
 */
export const usersStep: MigrationStep = modelStep({
  name: 'users',
  description: 'Employees and their linked auth providers',
  targets: ['users', 'user_auth_providers'],
  requires: ['organizations', 'departments'],
  publishes: 'users',
  model: UserModel as never,
  withDeleted: true,
  // The hashes the schema hides from ordinary reads. Without these a migrated user cannot log
  // in and cannot complete MFA, and the rollback path — which is the whole reason the column is
  // kept — would authenticate nobody.
  select: '+passwordHash +mfa.secret +mfa.backupCodes',
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'users._id');
    const organizationId = requiredOid(document.organizationId, 'users.organizationId');
    if (!context.known.get('organizations')?.has(organizationId)) {
      return { kind: 'skip', reason: `organization ${organizationId} was not migrated` };
    }

    const departmentId = oid(document.departmentId);
    const statements: Statement[] = [
      upsert('users', {
        id,
        organization_id: organizationId,
        email: str(document.email),
        email_domain: str(document.emailDomain),
        name: str(document.name),
        avatar_url: nullableStr(document.avatarUrl),
        job_title: nullableStr(document.jobTitle),
        phone: nullableStr(document.phone),
        password_hash: nullableStr(document.passwordHash),
        password_updated_at: iso(document.passwordUpdatedAt),
        must_change_password: bool(document.mustChangePassword),
        mfa: json(document.mfa, '{"enabled":false}'),
        preferences: json(document.preferences, '{}'),
        status: enumValue(document.status, USER_STATUSES, 'invited'),
        is_super_admin: bool(document.isSuperAdmin),
        // Departments are loaded first, so this is a live foreign key by the time it is written.
        // A user whose department was not migrated keeps the user rather than losing them.
        department_id:
          departmentId && context.known.get('departments')?.has(departmentId) ? departmentId : null,
        storage_quota_bytes: num(document.storageQuotaBytes),
        storage_used_bytes: num(document.storageUsedBytes),
        last_login_at: iso(document.lastLoginAt),
        last_active_at: iso(document.lastActiveAt),
        failed_login_count: num(document.failedLoginCount),
        locked_until: iso(document.lockedUntil),
        invited_by: null,
        invited_at: iso(document.invitedAt),
        activated_at: iso(document.activatedAt),
        deactivated_at: iso(document.deactivatedAt),
        deactivated_by: null,
        deactivation_reason: nullableStr(document.deactivationReason),
        ...timestamps(document),
        deleted_at: iso(document.deletedAt),
        deleted_by: oid(document.deletedBy),
      }),
      // Delete-then-insert, so a provider unlinked in MongoDB disappears on a re-run rather
      // than lingering as a credential nobody can see in the source database.
      deleteWhere('user_auth_providers', { user_id: id }),
    ];

    const providers = Array.isArray(document.authProviders) ? document.authProviders : [];
    const seen = new Set<string>();
    for (const raw of providers) {
      const entry = raw as Record<string, unknown>;
      const provider = enumValue(entry.provider, AUTH_PROVIDERS, 'password');
      // `ux_user_auth_providers` is unique on (user, provider). A duplicate in the source would
      // abort the batch and take the other 499 records with it, so it is dropped here instead.
      if (seen.has(provider)) continue;
      seen.add(provider);

      statements.push(
        insert('user_auth_providers', {
          id: derivedId('uap_', id, provider),
          user_id: id,
          provider,
          provider_account_id: nullableStr(entry.providerAccountId),
          linked_at: requiredIso(entry.linkedAt, requiredIso(document.createdAt, new Date(0).toISOString())),
        }),
      );
    }

    return { kind: 'write', statements };
  },
});

/**
 * The circular references, once both ends exist.
 *
 * Reads departments and users a second time. That is cheaper than it looks — the projection is
 * four fields — and much cheaper than the alternative, which is holding every deferred value in
 * memory for the length of the run and losing it on a restart.
 */
export const departmentBackfillStep: MigrationStep = modelStep({
  name: 'departments-backfill',
  description: 'Department heads, parents and creators',
  targets: ['departments'],
  requires: ['departments', 'users'],
  model: DepartmentModel as never,
  withDeleted: true,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'departments._id');
    const headUserId = oid(document.headUserId);
    const parentDepartmentId = oid(document.parentDepartmentId);
    const createdBy = oid(document.createdBy);

    const knownUsers = context.known.get('users');
    const knownDepartments = context.known.get('departments');

    return {
      kind: 'write',
      statements: [
        update(
          'departments',
          {
            head_user_id: headUserId && knownUsers?.has(headUserId) ? headUserId : null,
            parent_department_id:
              parentDepartmentId && knownDepartments?.has(parentDepartmentId)
                ? parentDepartmentId
                : null,
            created_by: createdBy && knownUsers?.has(createdBy) ? createdBy : null,
          },
          { id },
        ),
      ],
    };
  },
});

export const userBackfillStep: MigrationStep = modelStep({
  name: 'users-backfill',
  description: 'Inviter and deactivator references',
  targets: ['users'],
  requires: ['users'],
  model: UserModel as never,
  withDeleted: true,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'users._id');
    const invitedBy = oid(document.invitedBy);
    const deactivatedBy = oid(document.deactivatedBy);
    const known = context.known.get('users');

    // Nothing to say. Emitting an UPDATE that sets both columns to the value they already hold
    // is harmless but costs a statement per user, and most users were neither invited by anyone
    // nor deactivated.
    if (!invitedBy && !deactivatedBy) return { kind: 'write', statements: [] };

    return {
      kind: 'write',
      statements: [
        update(
          'users',
          {
            invited_by: invitedBy && known?.has(invitedBy) ? invitedBy : null,
            deactivated_by: deactivatedBy && known?.has(deactivatedBy) ? deactivatedBy : null,
          },
          { id },
        ),
      ],
    };
  },
});

export const appSettingsStep: MigrationStep = modelStep({
  name: 'app-settings',
  description: 'Runtime settings',
  targets: ['app_settings'],
  requires: ['organizations', 'users'],
  model: AppSettingModel as never,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'app_settings._id');
    const organizationId = requiredOid(document.organizationId, 'app_settings.organizationId');
    if (!context.known.get('organizations')?.has(organizationId)) {
      return { kind: 'skip', reason: `organization ${organizationId} was not migrated` };
    }
    const updatedBy = oid(document.updatedBy);

    return {
      kind: 'write',
      statements: [
        upsert('app_settings', {
          id,
          organization_id: organizationId,
          key: str(document.key),
          value: json(document.value),
          description: str(document.description),
          updated_by: updatedBy && context.known.get('users')?.has(updatedBy) ? updatedBy : null,
          ...timestamps(document),
        }),
      ],
    };
  },
});

export { timestamps };
