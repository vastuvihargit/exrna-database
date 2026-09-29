import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { requireActor } from '@/server/http/page-guard';
import { isWorkerRuntime } from '@/server/runtime';

/**
 * Administration area.
 *
 * The guard runs server-side on every render. Hiding the nav item in the sidebar is a
 * convenience; this redirect is the control.
 */
export const dynamic = 'force-dynamic';

const ADMIN_TABS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Employees' },
  { href: '/admin/departments', label: 'Departments' },
  { href: '/admin/templates', label: 'Templates' },
  /**
   * Two different things used to both be called "Migrations", and they run in opposite
   * directions: one pulls content *from* somebody's Drive into this platform, the other
   * moves this platform's files *into* the company Shared Drive. An operator picking the
   * wrong one is not a cosmetic problem, so the labels say which is which.
   */
  { href: '/admin/migrations', label: 'Import from Drive', nodeOnly: true },
  { href: '/admin/storage-migration', label: 'Drive storage', nodeOnly: true },
  { href: '/admin/audit-logs', label: 'Audit log' },
  { href: '/admin/system', label: 'System' },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor('/admin');

  const allowed =
    actor.isSuperAdmin ||
    actor.grants.some(
      (grant) =>
        (grant.permissions.includes('user.manage') || grant.permissions.includes('audit.view')) &&
        (grant.scopeType === 'company' || grant.scopeType === 'department'),
    );

  if (!allowed) redirect('/access-denied?reason=permission');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Administration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Employees, departments, roles and the audit trail.
        </p>
      </div>

      <nav aria-label="Administration sections" className="flex flex-wrap gap-1 border-b">
        {/* The two Node-only migration tools (server/http/node-only.ts) are not offered on a Worker. */}
        {ADMIN_TABS.filter((tab) => !(tab.nodeOnly && isWorkerRuntime())).map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="rounded-t-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {children}
    </div>
  );
}
