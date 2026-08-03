import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { getEnv } from '@/server/config/env';
import { bootstrap } from '@/server/bootstrap';
import { requireActor } from '@/server/http/page-guard';

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
  await requireActor();

  const { APP_NAME } = getEnv();
  return <AppShell appName={APP_NAME}>{children}</AppShell>;
}
