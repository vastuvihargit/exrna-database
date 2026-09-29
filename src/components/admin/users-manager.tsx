'use client';

import * as React from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { MoreHorizontal, Search, ShieldCheck, UserCheck, UserX } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import { useAdminUsers, useDepartments, useSetUserStatus, type AdminUser } from '@/hooks/use-admin';
import { CreateUserDialog } from './create-user-dialog';
import { DeactivateUserDialog } from './deactivate-user-dialog';
import { UserRolesDialog } from './user-roles-dialog';
import { UserStatusBadge } from './user-status-badge';

const PAGE_SIZE = 25;

// A stable empty list. TanStack Table resets the page index whenever `data` changes identity,
// and that reset is a state update: `data?.items ?? []` hands it a fresh array on every render
// while the list is loading, so each render schedules the next one.
const NO_USERS: AdminUser[] = [];

export function UsersManager({ companyDomains }: { companyDomains: string[] }) {
  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [status, setStatus] = React.useState('all');
  const [departmentId, setDepartmentId] = React.useState('all');
  const [page, setPage] = React.useState(1);

  // Held by id, not by value: after granting or revoking a role the list refetches, and
  // the dialog must show the updated roles rather than the snapshot it opened with.
  const [rolesTargetId, setRolesTargetId] = React.useState<string | null>(null);
  const [deactivateTargetId, setDeactivateTargetId] = React.useState<string | null>(null);

  // Debounced so typing does not fire a query per keystroke.
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isPending, isError, error } = useAdminUsers({
    search: debouncedSearch || undefined,
    status,
    departmentId,
    page,
    pageSize: PAGE_SIZE,
  });
  const { data: departments } = useDepartments();
  const setUserStatus = useSetUserStatus();

  const departmentName = React.useCallback(
    (id: string | null) => departments?.find((department) => department.id === id)?.code ?? '—',
    [departments],
  );

  const columns = React.useMemo<ColumnDef<AdminUser>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Employee',
        cell: ({ row }) => (
          <div className="min-w-48">
            <p className="font-medium">{row.original.name}</p>
            <p className="text-xs text-muted-foreground">{row.original.email}</p>
          </div>
        ),
      },
      {
        accessorKey: 'departmentId',
        header: 'Dept',
        cell: ({ row }) => <span className="text-sm">{departmentName(row.original.departmentId)}</span>,
      },
      {
        id: 'roles',
        header: 'Roles',
        cell: ({ row }) =>
          row.original.roles.length === 0 ? (
            <span className="text-xs text-muted-foreground">No roles</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {row.original.roles.map((role) => (
                <Badge key={role.grantId} variant="outline" className="text-[11px]">
                  {role.roleName}
                </Badge>
              ))}
            </div>
          ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <UserStatusBadge status={row.original.status} />,
      },
      {
        accessorKey: 'lastLoginAt',
        header: 'Last sign-in',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {row.original.lastLoginAt ? formatRelativeTime(row.original.lastLoginAt) : 'Never'}
          </span>
        ),
      },
      {
        id: 'storage',
        header: 'Storage',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {formatBytes(row.original.storageUsedBytes)} / {formatBytes(row.original.storageQuotaBytes)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const user = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Actions for ${user.name}`}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setRolesTargetId(user.id)}>
                  <ShieldCheck className="size-4" /> Manage roles
                </DropdownMenuItem>
                {user.status === 'active' ? (
                  <DropdownMenuItem onClick={() => setDeactivateTargetId(user.id)}>
                    <UserX className="size-4" /> Deactivate
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={() => setUserStatus.mutate({ userId: user.id, status: 'active' })}
                  >
                    <UserCheck className="size-4" /> Activate
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [departmentName, setUserStatus],
  );

  const table = useReactTable({
    data: data?.items ?? NO_USERS,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const rolesTarget = data?.items.find((user) => user.id === rolesTargetId) ?? null;
  const deactivateTarget = data?.items.find((user) => user.id === deactivateTargetId) ?? null;

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            className="pl-9"
            placeholder="Search by name or email"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search employees"
          />
        </div>

        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="invited">Invited</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
            <SelectItem value="deactivated">Deactivated</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={departmentId}
          onValueChange={(value) => {
            setDepartmentId(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-48" aria-label="Filter by department">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All departments</SelectItem>
            {departments?.map((department) => (
              <SelectItem key={department.id} value={department.id}>
                {department.code} — {department.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <CreateUserDialog companyDomains={companyDomains} />
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {/* Loading */}
            {isPending
              ? Array.from({ length: 5 }, (_, index) => (
                  <TableRow key={`skeleton-${index}`}>
                    <TableCell colSpan={columns.length}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : null}

            {/* Error */}
            {isError ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-8 text-center text-sm">
                  <p className="font-medium text-destructive">Could not load employees</p>
                  <p className="mt-1 text-muted-foreground">
                    {error instanceof Error ? error.message : 'Unknown error'}
                  </p>
                </TableCell>
              </TableRow>
            ) : null}

            {/* Empty */}
            {!isPending && !isError && table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-10 text-center text-sm text-muted-foreground">
                  No employees match these filters.
                </TableCell>
              </TableRow>
            ) : null}

            {/* Populated */}
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {data ? `${data.total} employee${data.total === 1 ? '' : 's'}` : ''}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </Button>
          <span>
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      <UserRolesDialog
        user={rolesTarget}
        open={Boolean(rolesTarget)}
        onOpenChange={(open) => !open && setRolesTargetId(null)}
      />
      <DeactivateUserDialog
        user={deactivateTarget}
        open={Boolean(deactivateTarget)}
        onOpenChange={(open) => !open && setDeactivateTargetId(null)}
      />
    </div>
  );
}
