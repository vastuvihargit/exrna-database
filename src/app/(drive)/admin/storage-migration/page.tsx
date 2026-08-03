import type { Metadata } from 'next';

import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StorageMigrationManager } from '@/components/admin/storage-migration-manager';
import { requireActor } from '@/server/http/page-guard';
import { describeDriveStorage } from '@/server/storage';

export const metadata: Metadata = { title: 'Drive storage' };
export const dynamic = 'force-dynamic';

/**
 * Moving this platform's files into the company Shared Drive.
 *
 * ⚠ The opposite direction from `/admin/migrations`, which imports *from* somebody's Drive
 * into this platform and is read-only. The tab labels say which is which, because an
 * operator picking the wrong one is not a cosmetic problem.
 *
 * Gated twice: the admin layout redirects anyone without an administrative grant, and every
 * endpoint behind this page independently requires company-scoped `access.manage` — a
 * higher bar than the rest of the admin area, because this moves research data between
 * storage systems.
 */
export default async function StorageMigrationPage() {
  await requireActor('/admin/storage-migration');
  const drive = describeDriveStorage();

  if (!drive.enabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Google Shared Drive is not switched on</CardTitle>
          <CardDescription>
            Files are stored on this server. To move them to a company Shared Drive, connect it
            first — the connection status is on the System tab. Nothing here can run until then.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {!drive.configured ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">The Shared Drive connection is not working</CardTitle>
            <CardDescription>
              Migration cannot run until it is fixed. The System tab explains what is wrong.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <StorageMigrationManager />
    </div>
  );
}
