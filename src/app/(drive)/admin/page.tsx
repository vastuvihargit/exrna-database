import type { Metadata } from 'next';
import Link from 'next/link';
import { Building2, ScrollText, Users } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireActor } from '@/server/http/page-guard';
import { userService } from '@/server/services/user.service';
import { departmentService } from '@/server/services/department.service';

export const metadata: Metadata = { title: 'Administration' };
export const dynamic = 'force-dynamic';

/**
 * Server component: counts are read through the same permission-checked services the
 * API uses, so this page cannot show a number the viewer is not entitled to.
 */
export default async function AdminOverviewPage() {
  const actor = await requireActor('/admin');

  const [departments, activeUsers, invitedUsers, deactivatedUsers] = await Promise.all([
    departmentService.list(actor),
    userService.listForAdmin(actor, { status: 'active', page: 1, pageSize: 1 }).catch(() => ({ total: 0 })),
    userService.listForAdmin(actor, { status: 'invited', page: 1, pageSize: 1 }).catch(() => ({ total: 0 })),
    userService
      .listForAdmin(actor, { status: 'deactivated', page: 1, pageSize: 1 })
      .catch(() => ({ total: 0 })),
  ]);

  const tiles = [
    { label: 'Active employees', value: activeUsers.total, href: '/admin/users', icon: Users },
    { label: 'Pending invitations', value: invitedUsers.total, href: '/admin/users', icon: Users },
    { label: 'Deactivated', value: deactivatedUsers.total, href: '/admin/users', icon: Users },
    { label: 'Departments', value: departments.length, href: '/admin/departments', icon: Building2 },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <Link key={tile.label} href={tile.href} className="rounded-lg">
              <Card className="transition-colors hover:bg-muted/40">
                <CardContent className="flex items-center gap-4 p-5">
                  <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
                  <div>
                    <p className="text-2xl font-semibold tabular-nums">{tile.value}</p>
                    <p className="text-xs text-muted-foreground">{tile.label}</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Access model</CardTitle>
          <CardDescription>How access is decided in this system.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Sign-in</strong> is limited to approved company email
            domains. Owning a company address does not by itself grant access — an administrator
            creates the account.
          </p>
          <p>
            <strong className="text-foreground">Access</strong> comes from roles granted at a scope
            (company, department, project, folder, file). Granting or revoking a role signs the
            employee out so the change applies at once.
          </p>
          <p className="flex items-center gap-2 pt-2">
            <ScrollText className="size-4" aria-hidden="true" />
            Every action on this page is recorded in the{' '}
            <Link href="/admin/audit-logs" className="font-medium text-primary underline underline-offset-4">
              audit log
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
