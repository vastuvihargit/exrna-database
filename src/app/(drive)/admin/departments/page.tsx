import type { Metadata } from 'next';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBytes } from '@/lib/utils';
import { requireActor } from '@/server/http/page-guard';
import { departmentService } from '@/server/services/department.service';
import { CreateDepartmentDialog } from '@/components/admin/create-department-dialog';

export const metadata: Metadata = { title: 'Departments' };
export const dynamic = 'force-dynamic';

export default async function AdminDepartmentsPage() {
  const actor = await requireActor('/admin/departments');
  const departments = await departmentService.list(actor);

  const canManage =
    actor.isSuperAdmin ||
    actor.grants.some((grant) => grant.scopeType === 'company' && grant.permissions.includes('user.manage'));

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Departments</CardTitle>
          <CardDescription>
            The coarsest access boundary. Each department gets its own drive and storage quota.
          </CardDescription>
        </div>
        {canManage ? <CreateDepartmentDialog /> : null}
      </CardHeader>

      <CardContent>
        {departments.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm font-medium">No departments yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create one to start organizing employees and research drives.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {departments.map((department) => (
                <TableRow key={department.id}>
                  <TableCell className="font-mono text-xs">{department.code}</TableCell>
                  <TableCell>
                    <p className="font-medium">{department.name}</p>
                    {department.description ? (
                      <p className="text-xs text-muted-foreground">{department.description}</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="tabular-nums">{department.memberCount}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatBytes(department.storageUsedBytes)} / {formatBytes(department.storageQuotaBytes)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={department.isActive ? 'success' : 'secondary'}>
                      {department.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
