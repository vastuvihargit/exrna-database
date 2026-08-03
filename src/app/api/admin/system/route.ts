import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { systemService } from '@/server/services/system.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Operational status for administrators.
 *
 * Read-only by design. Everything it reports on — backups, integrity sweeps, the
 * antivirus — is operated from outside the application, so there is no action here for
 * an HTTP request to take. That is deliberate: an endpoint that could trigger a restore
 * or a purge would be a far more attractive target than one that can only look.
 *
 * Gated on company-scoped `audit.view`. Free disk space, backup ages and quarantine
 * counts are exactly the reconnaissance an attacker with a foothold would want, so this
 * sits behind the same bar as the audit log rather than behind "is an administrator" —
 * a department head administers their own people, not the server.
 *
 * The check appears here *and* inside `getSystemStatus`. That is deliberate: the service
 * check is what protects the server-rendered admin page, and the route-level assertion is
 * what makes the gate visible where the endpoint is defined rather than one indirection
 * away.
 */
export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  assertCompanyPermission(actor, 'audit.view');

  const status = await systemService.getSystemStatus(actor);

  return ok({
    status: status.status,
    checks: status.checks,
    storage: status.storage,
    backup: {
      lastRunAt: status.backup.lastRunAt?.toISOString() ?? null,
      ageHours: status.backup.ageHours,
      offsite: status.backup.offsite,
      verified: status.backup.verified,
      ok: status.backup.ok,
      detail: status.backup.detail,
      lastDrillAt: status.backup.lastDrillAt?.toISOString() ?? null,
      lastDrillOk: status.backup.lastDrillOk,
    },
    uploads: status.uploads,
    malwareScanning: status.malwareScanning,
    generatedAt: status.generatedAt.toISOString(),
  });
});
