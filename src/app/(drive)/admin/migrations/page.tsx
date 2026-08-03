import type { Metadata } from 'next';

import { requireActor } from '@/server/http/page-guard';
import { MigrationsManager } from '@/components/admin/migrations-manager';

export const metadata: Metadata = { title: 'Migrations' };
export const dynamic = 'force-dynamic';

export default async function AdminMigrationsPage() {
  // The section layout guards the area; the API re-checks company-scoped access.manage on
  // every call, which is the control. This is defence in depth, not the gate.
  await requireActor('/admin/migrations');
  return <MigrationsManager />;
}
