import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { checkDriveConnection, describeDriveStorage } from '@/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Google Shared Drive connection status, for administrators.
 *
 * The counterpart to `/api/health/ready`, which is unauthenticated and therefore reports
 * two booleans and nothing more. This one carries the identifiers somebody actually needs
 * to *fix* a broken connection — the drive id, the root folder id, the service-account
 * address and Google's own error text — which is why it sits behind company-scoped
 * `audit.view`, the same bar as the audit log. A department head administers their people,
 * not the company's storage backend.
 *
 * It never returns the service-account key, in any form. `describeDriveStorage()` returns a
 * type with no field the key could be assigned to, so that is a property of the types
 * rather than of this handler remembering to omit it. `keySource` reports *where* the key
 * came from, which is what the production warning is about.
 *
 * Read-only, and there is no companion POST. Rotating a credential or repointing the drive
 * is a deployment action; an endpoint that could do it over HTTP would be a far more
 * attractive target than one that can only look.
 *
 * `force=1` skips the short-lived cache, so an administrator who has just fixed the Drive
 * membership sees the result immediately instead of waiting out a TTL.
 */
export const GET = withAuthenticatedRoute(async (request, { actor }) => {
  assertCompanyPermission(actor, 'audit.view');

  const force = new URL(request.url).searchParams.get('force') === '1';
  const summary = describeDriveStorage();
  const connection = await checkDriveConnection({ force });

  return ok({
    enabled: summary.enabled,
    configured: summary.configured,
    connected: connection.connected,
    /** Where new uploads are configured to go. Not the same question as "is Drive on". */
    defaultProvider: summary.defaultProvider,
    drive: {
      id: summary.sharedDriveId,
      name: connection.driveName,
      rootFolderId: summary.rootFolderId,
      canAddContent: connection.canAddContent,
      rootFolderOk: connection.rootFolderOk,
    },
    credential: {
      serviceAccountEmail: summary.serviceAccountEmail,
      keySource: summary.keySource,
      workspaceDomain: summary.workspaceDomain,
    },
    error: connection.error,
    warnings: summary.warnings,
    checkedAt: connection.checkedAt.toISOString(),
  });
});
