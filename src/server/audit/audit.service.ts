/**
 * Audit layer.
 *
 * Services call this for every sensitive action. Audit failures are logged but never
 * propagated: a broken audit sink must not roll back a legitimate business operation,
 * and it must not be a denial-of-service lever either. The failure is loud in the logs
 * and surfaces on the admin health page.
 *
 * Where a write must be atomic with the action it describes (Phase 4 upload
 * finalization, Phase 8 approval), pass the transaction session — then it commits or
 * rolls back with the rest.
 */
import type { ClientSession } from 'mongoose';
import * as auditRepository from '@/server/repositories/audit-log.repository';
import type { AuditAction } from '@/server/db/models';
import { getLogger } from '@/server/logging/logger';
import type { Actor } from '@/server/permissions/actor';
import type { RequestMeta } from '@/server/http/request-meta';

export interface AuditEvent {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  outcome?: 'success' | 'denied' | 'error';
  severity?: 'info' | 'notice' | 'warning' | 'critical';
}

/** Actions that must never be recorded without a stated reason. */
const REASON_REQUIRED = new Set<AuditAction>([
  'user.deactivated',
  'resource.purge',
  'role.deleted',
  'department.deleted',
]);

export async function recordForActor(
  actor: Actor,
  meta: RequestMeta,
  event: AuditEvent,
  session?: ClientSession,
): Promise<void> {
  await write(
    {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorEmail: actor.email,
      actorRoleKeys: actor.roleKeys,
      ...event,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    },
    session,
  );
}

/** For events with no authenticated actor yet: failed logins, OAuth errors. */
export async function recordAnonymous(
  meta: RequestMeta,
  event: AuditEvent & { actorEmail?: string | null; organizationId?: string | null },
): Promise<void> {
  await write({
    organizationId: event.organizationId ?? null,
    actorUserId: null,
    actorEmail: event.actorEmail ?? null,
    actorRoleKeys: [],
    ...event,
    ip: meta.ip,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  });
}

/**
 * For work no person asked for: scheduled sweeps, drains, reconciliation.
 *
 * §17 of the brief requires every migration entry to name "a user **or system** actor", and
 * this is that second case. The alternative — running background work as a synthetic
 * administrator — would put a permission-bearing identity into the audit trail that nobody
 * can be held to, and would make "an administrator did this" and "a cron job did this"
 * indistinguishable in exactly the review where the difference matters.
 *
 * `ip` and `userAgent` say `system` rather than `unknown` for the same reason: the request
 * did not come from somewhere unrecorded, it did not come from anywhere.
 */
export async function recordSystem(
  event: AuditEvent & { organizationId?: string | null; actorLabel: string },
  session?: ClientSession,
): Promise<void> {
  const { actorLabel, organizationId, ...rest } = event;
  await write(
    {
      organizationId: organizationId ?? null,
      actorUserId: null,
      actorEmail: `system:${actorLabel}`,
      actorRoleKeys: [],
      ...rest,
      ip: 'system',
      userAgent: 'system',
      requestId: null,
    },
    session,
  );
}

async function write(
  input: Parameters<typeof auditRepository.append>[0],
  session?: ClientSession,
): Promise<void> {
  if (REASON_REQUIRED.has(input.action) && !input.reason) {
    getLogger().warn({ action: input.action }, 'Audit event recorded without a required reason');
  }

  try {
    await auditRepository.append(input, session);
  } catch (error) {
    getLogger().error({ err: error, action: input.action }, 'Failed to write audit log');
    // Deliberately swallowed when not in a transaction — see the module comment.
    if (session) throw error;
  }
}

export const auditService = { recordForActor, recordAnonymous, recordSystem };
