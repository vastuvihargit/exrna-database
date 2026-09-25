/**
 * The record of what happened: audit, sessions, login history, activity, and the three
 * per-user lists (stars, recent, saved searches).
 *
 * ── Sessions are migrated, and that is a deliberate reversal ────────────────────────────
 *
 * The earlier readiness note treated `DATA_SOURCE_SESSIONS` as a flag that logs everybody out,
 * because the new engine would hold none of the existing sessions. It does not have to: a
 * session is a row like any other, and copying it means the flag can be flipped inside the
 * write freeze without invalidating every logged-in employee's cookie. The token hashes are
 * `select: false` in the schema and are read explicitly here — a sessions table migrated
 * without them authenticates nobody and looks complete.
 *
 * Expired and revoked sessions come too. `login_history.session_id` references them, and a
 * login record whose session row is missing loses the ability to answer "which device was that
 * login on?", which is the question a security review asks.
 */
import {
  ActivityModel,
  AuditLogModel,
  LoginHistoryModel,
  RecentItemModel,
  SavedSearchModel,
  SessionModel,
  StarModel,
} from '@/server/db/models';
import { ACTIVITY_ENTITY_TYPES } from '@/server/db/models/activity.model';
import { AUDIT_ACTIONS, AUDIT_OUTCOMES } from '@/server/db/models/audit-log.model';
import { LOGIN_OUTCOMES } from '@/server/db/models/login-history.model';
import { RECENT_ENTITY_TYPES } from '@/server/db/models/recent-item.model';
import { SESSION_REVOKE_REASONS } from '@/server/db/models/session.model';
import { STARRABLE_TYPES } from '@/server/db/models/star.model';
import {
  bool,
  enumValue,
  iso,
  json,
  jsonArray,
  nullableEnum,
  nullableStr,
  num,
  oid,
  oidList,
  requiredIso,
  requiredOid,
  str,
} from '../convert';
import { deleteWhere, insert, insertImmutable, update, upsert } from '../sql';
import { modelStep } from '../step-helpers';
import type { MigrationStep, Statement } from '../types';
import { timestamps } from './identity';

/**
 * The audit trail.
 *
 * Append-only at both engines: MongoDB refuses updates and deletes in a pre-hook, D1 enforces it
 * with triggers from migration 0000. So this step writes each row once and the rows it writes
 * carry the original `created_at` — an audit log that claims every historical event happened at
 * cutover is not an audit log.
 *
 * `organization_id` and `actor_user_id` are nullable here and are the one place the migration
 * relaxes a reference: a login-failure record for an email that never became a user has no
 * actor, and dropping those rows would delete exactly the evidence a brute-force investigation
 * needs. An actor id that no longer resolves is cleared rather than dropping the row, and
 * `actor_email` — which is on the row — keeps the identity legible.
 */
export const auditLogsStep: MigrationStep = modelStep({
  name: 'audit-logs',
  description: 'The audit trail',
  targets: ['audit_logs'],
  requires: ['organizations', 'users'],
  model: AuditLogModel as never,
  deltaField: 'createdAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'audit_logs._id');
    const organizationId = oid(document.organizationId);
    const actorUserId = oid(document.actorUserId);
    const knownUsers = context.known.get('users');

    /**
     * An action outside the catalogue fails the CHECK and would abort the batch, taking every
     * other record in it. It cannot be defaulted either: an audit row relabelled as some other
     * action is worse than an absent one, because it reads as evidence of something that did not
     * happen. So the record becomes a reported failure with its id, and a human decides whether
     * the catalogue needs extending or the row is junk.
     */
    const action = str(document.action);
    if (!(AUDIT_ACTIONS as readonly string[]).includes(action)) {
      throw new Error(`audit action "${action}" is not in the catalogue`);
    }

    return {
      kind: 'write',
      statements: [
        insertImmutable('audit_logs', {
          id,
          organization_id:
            organizationId && context.known.get('organizations')?.has(organizationId)
              ? organizationId
              : null,
          actor_user_id: actorUserId && knownUsers?.has(actorUserId) ? actorUserId : null,
          actor_email: nullableStr(document.actorEmail),
          actor_role_keys: jsonArray(document.actorRoleKeys),
          action,
          entity_type: str(document.entityType),
          entity_id: nullableStr(document.entityId),
          entity_label: nullableStr(document.entityLabel),
          previous_value: document.previousValue === null ? null : json(document.previousValue),
          new_value: document.newValue === null ? null : json(document.newValue),
          reason: nullableStr(document.reason),
          ip: str(document.ip, 'unknown'),
          user_agent: str(document.userAgent, 'unknown'),
          request_id: nullableStr(document.requestId),
          outcome: enumValue(document.outcome, AUDIT_OUTCOMES, 'success'),
          severity: enumValue(
            document.severity,
            ['info', 'notice', 'warning', 'critical'] as const,
            'info',
          ),
          created_at: requiredIso(document.createdAt, new Date(0).toISOString()),
        }),
      ],
    };
  },
});

export const sessionsStep: MigrationStep = modelStep({
  name: 'sessions',
  description: 'Live and historical sessions (rotation chains deferred)',
  targets: ['sessions'],
  requires: ['users', 'organizations'],
  publishes: 'sessions',
  model: SessionModel as never,
  // Both hashes are `select: false`. Without them the table is a list of session ids nobody can
  // present a cookie for.
  select: '+tokenHash +csrfTokenHash',
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'sessions._id');
    const userId = requiredOid(document.userId, 'sessions.userId');
    const organizationId = requiredOid(document.organizationId, 'sessions.organizationId');

    if (!context.known.get('users')?.has(userId)) {
      return { kind: 'skip', reason: `user ${userId} was not migrated` };
    }
    const tokenHash = str(document.tokenHash);
    if (tokenHash.length === 0) {
      // Reading without the projection produces exactly this. Failing loudly is the only way it
      // does not become "everybody is logged out and nobody knows why".
      return { kind: 'skip', reason: 'the session token hash was not readable' };
    }

    const createdAt = requiredIso(document.createdAt, new Date(0).toISOString());
    return {
      kind: 'write',
      statements: [
        upsert('sessions', {
          id,
          user_id: userId,
          organization_id: organizationId,
          token_hash: tokenHash,
          csrf_token_hash: str(document.csrfTokenHash),
          expires_at: requiredIso(document.expiresAt, createdAt),
          absolute_expires_at: requiredIso(document.absoluteExpiresAt, createdAt),
          last_used_at: requiredIso(document.lastUsedAt, createdAt),
          rotated_from_id: null,
          rotated_at: iso(document.rotatedAt),
          ip: str(document.ip, 'unknown'),
          user_agent: str(document.userAgent, 'unknown'),
          device_label: str(document.deviceLabel, 'Unknown device'),
          provider: str(document.provider, 'password'),
          revoked_at: iso(document.revokedAt),
          revoked_reason: nullableEnum(document.revokedReason, SESSION_REVOKE_REASONS),
          ...timestamps(document),
        }),
      ],
    };
  },
});

export const sessionBackfillStep: MigrationStep = modelStep({
  name: 'sessions-backfill',
  description: 'Session rotation chains',
  targets: ['sessions'],
  requires: ['sessions'],
  model: SessionModel as never,
  select: '_id rotatedFromId',
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'sessions._id');
    const rotatedFromId = oid(document.rotatedFromId);
    if (!rotatedFromId) return { kind: 'write', statements: [] };

    const known = context.known.get('sessions');
    return {
      kind: 'write',
      statements: [
        update(
          'sessions',
          { rotated_from_id: known?.has(rotatedFromId) ? rotatedFromId : null },
          { id },
        ),
      ],
    };
  },
});

export const loginHistoryStep: MigrationStep = modelStep({
  name: 'login-history',
  description: 'Login attempts',
  targets: ['login_history'],
  requires: ['users', 'sessions'],
  model: LoginHistoryModel as never,
  deltaField: 'createdAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'login_history._id');
    const userId = oid(document.userId);
    const sessionId = oid(document.sessionId);

    return {
      kind: 'write',
      statements: [
        upsert('login_history', {
          id,
          // Nullable by design: a failed login for an unknown email has no user, and that row is
          // the one a brute-force investigation reads.
          user_id: userId && context.known.get('users')?.has(userId) ? userId : null,
          email: str(document.email),
          outcome: enumValue(document.outcome, LOGIN_OUTCOMES, 'oauth_error'),
          provider: str(document.provider, 'password'),
          ip: str(document.ip, 'unknown'),
          user_agent: str(document.userAgent, 'unknown'),
          session_id:
            sessionId && context.known.get('sessions')?.has(sessionId) ? sessionId : null,
          detail: nullableStr(document.detail),
          created_at: requiredIso(document.createdAt, new Date(0).toISOString()),
        }),
      ],
    };
  },
});

export const activitiesStep: MigrationStep = modelStep({
  name: 'activities',
  description: 'The "what happened here" timeline',
  targets: ['activities', 'activity_folders'],
  requires: ['users', 'folders', 'projects'],
  model: ActivityModel as never,
  deltaField: 'createdAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'activities._id');
    const organizationId = requiredOid(document.organizationId, 'activities.organizationId');
    const actorUserId = requiredOid(document.actorUserId, 'activities.actorUserId');

    if (!context.known.get('users')?.has(actorUserId)) {
      return { kind: 'skip', reason: `actor ${actorUserId} was not migrated` };
    }

    const departmentId = oid(document.departmentId);
    const projectId = oid(document.projectId);
    const knownFolders = context.known.get('folders');

    const statements: Statement[] = [
      upsert('activities', {
        id,
        organization_id: organizationId,
        actor_user_id: actorUserId,
        actor_name: str(document.actorName),
        action: str(document.action),
        entity_type: enumValue(document.entityType, ACTIVITY_ENTITY_TYPES, 'file'),
        entity_id: requiredOid(document.entityId, 'activities.entityId'),
        entity_label: str(document.entityLabel),
        department_id:
          departmentId && context.known.get('departments')?.has(departmentId) ? departmentId : null,
        project_id: projectId && context.known.get('projects')?.has(projectId) ? projectId : null,
        detail: document.detail === null ? null : json(document.detail),
        created_at: requiredIso(document.createdAt, new Date(0).toISOString()),
      }),
      deleteWhere('activity_folders', { activity_id: id }),
    ];

    for (const folderId of new Set(oidList(document.contextFolderIds))) {
      if (!knownFolders?.has(folderId)) continue;
      statements.push(insert('activity_folders', { activity_id: id, folder_id: folderId }));
    }

    return { kind: 'write', statements };
  },
});

/**
 * Stars, recent items and saved searches.
 *
 * These name a folder or a file by id without a foreign key, which is deliberate in the schema —
 * `star.repository.ts` explains that a star is a user's private bookmark and does not constrain
 * the resource. The migration still checks: a star pointing at a purged file is dropped with a
 * reason rather than migrated as a row that renders as a broken tile.
 */
export const starsStep: MigrationStep = modelStep({
  name: 'stars',
  description: 'Starred folders and files',
  targets: ['stars'],
  requires: ['users', 'folders', 'files'],
  model: StarModel as never,
  deltaField: 'createdAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'stars._id');
    const userId = requiredOid(document.userId, 'stars.userId');
    const organizationId = requiredOid(document.organizationId, 'stars.organizationId');
    const entityType = enumValue(document.entityType, STARRABLE_TYPES, 'file');
    const entityId = requiredOid(document.entityId, 'stars.entityId');

    if (!context.known.get('users')?.has(userId)) {
      return { kind: 'skip', reason: `user ${userId} was not migrated` };
    }
    const table = entityType === 'file' ? 'files' : 'folders';
    if (!context.known.get(table)?.has(entityId)) {
      return { kind: 'skip', reason: `starred ${entityType} ${entityId} was not migrated` };
    }

    return {
      kind: 'write',
      statements: [
        upsert('stars', {
          id,
          user_id: userId,
          organization_id: organizationId,
          entity_type: entityType,
          entity_id: entityId,
          created_at: requiredIso(document.createdAt, new Date(0).toISOString()),
        }),
      ],
    };
  },
});

export const recentItemsStep: MigrationStep = modelStep({
  name: 'recent-items',
  description: 'Recently opened folders and files',
  targets: ['recent_items'],
  requires: ['users', 'folders', 'files'],
  model: RecentItemModel as never,
  // The collection has `timestamps: false`; `lastAccessedAt` is the only time it carries and is
  // exactly the right thing for a delta to filter on — but it is not indexed for `$gte` scans,
  // so a delta run reads the collection in full. It is small and per-user.
  deltaField: null,
  transform(document, context) {
    const id = requiredOid(document._id, 'recent_items._id');
    const userId = requiredOid(document.userId, 'recent_items.userId');
    const organizationId = requiredOid(document.organizationId, 'recent_items.organizationId');
    const entityType = enumValue(document.entityType, RECENT_ENTITY_TYPES, 'file');
    const entityId = requiredOid(document.entityId, 'recent_items.entityId');

    if (!context.known.get('users')?.has(userId)) {
      return { kind: 'skip', reason: `user ${userId} was not migrated` };
    }
    const table = entityType === 'file' ? 'files' : 'folders';
    if (!context.known.get(table)?.has(entityId)) {
      return { kind: 'skip', reason: `recent ${entityType} ${entityId} was not migrated` };
    }

    return {
      kind: 'write',
      statements: [
        upsert('recent_items', {
          id,
          user_id: userId,
          organization_id: organizationId,
          entity_type: entityType,
          entity_id: entityId,
          last_action: str(document.lastAction, 'opened'),
          last_accessed_at: requiredIso(document.lastAccessedAt, new Date(0).toISOString()),
        }),
      ],
    };
  },
});

export const savedSearchesStep: MigrationStep = modelStep({
  name: 'saved-searches',
  description: 'Saved searches',
  targets: ['saved_searches'],
  requires: ['users', 'organizations'],
  model: SavedSearchModel as never,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'saved_searches._id');
    const userId = requiredOid(document.userId, 'saved_searches.userId');
    const organizationId = requiredOid(document.organizationId, 'saved_searches.organizationId');

    if (!context.known.get('users')?.has(userId)) {
      return { kind: 'skip', reason: `user ${userId} was not migrated` };
    }
    const name = str(document.name);

    return {
      kind: 'write',
      statements: [
        upsert('saved_searches', {
          id,
          organization_id: organizationId,
          user_id: userId,
          name,
          name_lower: str(document.nameLower, name.toLowerCase()),
          // The criteria document moves whole. It is replayed as a whole and never filtered on.
          criteria: json(document.criteria, '{}'),
          is_pinned: bool(document.isPinned),
          last_run_at: iso(document.lastRunAt),
          run_count: num(document.runCount),
          ...timestamps(document),
        }),
      ],
    };
  },
});
