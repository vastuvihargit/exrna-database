import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AuditLogViewer } from '@/components/admin/audit-log-viewer';
import { requireActor } from '@/server/http/page-guard';

export const metadata: Metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

export default async function AdminAuditLogsPage() {
  const actor = await requireActor('/admin/audit-logs');

  const canView =
    actor.isSuperAdmin ||
    actor.grants.some((grant) => grant.scopeType === 'company' && grant.permissions.includes('audit.view'));

  if (!canView) redirect('/access-denied?reason=permission');

  return <AuditLogViewer />;
}
