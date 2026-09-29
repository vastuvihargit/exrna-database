import { Suspense } from 'react';
import type { Metadata } from 'next';

import { requireActor } from '@/server/http/page-guard';
import { MigrationCallback } from '@/components/admin/migration-callback';
import { NodeOnlyNotice } from '@/components/admin/node-only-notice';
import { NODE_ONLY_FEATURES } from '@/server/http/node-only';
import { isWorkerRuntime } from '@/server/runtime';

export const metadata: Metadata = { title: 'Connecting Google Drive' };
export const dynamic = 'force-dynamic';

/**
 * `GOOGLE_DRIVE_REDIRECT_URI` points here.
 *
 * Deliberately a page and not an API route: the authorization code arrives as a URL
 * parameter in a browser navigation, and the exchange is then a same-origin request that
 * carries the session cookie *and* the CSRF header — so the credential is only ever
 * attached to a migration by an authenticated administrator, not by whoever managed to
 * make a browser follow a redirect.
 */
export default async function MigrationCallbackPage() {
  await requireActor('/admin/migrations');
  if (isWorkerRuntime()) return <NodeOnlyNotice feature={NODE_ONLY_FEATURES.driveImport} />;
  return (
    <Suspense fallback={null}>
      <MigrationCallback />
    </Suspense>
  );
}
