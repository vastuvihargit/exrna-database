import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { NotFoundError } from '@/server/errors/app-error';
import * as sessionRepository from '@/server/repositories/session.repository';
import { revokeSession } from '@/server/auth/session.service';
import { auditService } from '@/server/audit/audit.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Revoke one of your own sessions.
 *
 * Ownership is checked before revocation — without it, a valid session id from another
 * user would be an IDOR that logs them out.
 */
export const DELETE = withAuthenticatedRoute<{ sessionId: string }>(
  async (_request, { params, actor, meta }) => {
    const sessionId = objectIdSchema.parse(params.sessionId);

    const target = await sessionRepository.findById(sessionId);
    if (!target || target.userId !== actor.userId) throw new NotFoundError();

    await revokeSession(sessionId, 'admin_revoked');

    await auditService.recordForActor(actor, meta, {
      action: 'auth.session_revoked',
      entityType: 'session',
      entityId: sessionId,
      entityLabel: target.deviceLabel,
      severity: 'notice',
    });

    return ok({ ok: true });
  },
);
