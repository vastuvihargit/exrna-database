import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import * as auditRepository from '@/server/repositories/audit-log.repository';
import { auditQuerySchema } from '@/server/validation/user.schemas';
import { parseQuery } from '@/server/validation/common';
import type { AuditAction, AuditOutcome } from '@/server/db/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only audit access for administrators.
 *
 * There is deliberately no POST, PATCH or DELETE on this path — the audit trail is
 * append-only, and the only writer is the audit service.
 */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  assertCompanyPermission(actor, 'audit.view');

  const query = parseQuery(auditQuerySchema, request.url);

  const { items, total } = await auditRepository.query({
    organizationId: actor.organizationId,
    ...(query.action ? { action: query.action as AuditAction } : {}),
    ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
    ...(query.outcome ? { outcome: query.outcome as AuditOutcome } : {}),
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    page: query.page,
    pageSize: query.pageSize,
  });

  return ok(items, { meta: { page: query.page, pageSize: query.pageSize, total } });
});
