import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { getEnv } from '@/server/config/env';
import { bootstrap } from '@/server/bootstrap';
import { requireActor } from '@/server/http/page-guard';
import { maintenanceMode } from '@/server/runtime/maintenance';

/**
 * Authenticated area.
 *
 * `requireActor()` is the real guard: it resolves the session against the database on
 * every render, so a deactivated employee is redirected to /login immediately even if
 * their cookie is still in the browser. The edge middleware only avoids a flash of
 * empty shell.
 */
export const dynamic = 'force-dynamic';

export default async function DriveLayout({ children }: { children: ReactNode }) {
  // Memoized: validates configuration and prepares the storage tree once per process.
  await bootstrap();

  // Full maintenance: no page renders, because rendering reads — and reads can write audit
  // and activity rows that would miss the final migration pass.
  if (maintenanceMode() === 'maintenance') {
    return (
      <main className="mx-auto max-w-lg p-10 text-center">
        <h1 className="text-xl font-semibold">Scheduled maintenance</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          The research drive is briefly unavailable while it is upgraded. Your files are safe.
          Please try again shortly.
        </p>
      </main>
    );
  }

  await requireActor();

  const { APP_NAME } = getEnv();
  return <AppShell appName={APP_NAME}>{children}</AppShell>;
}
