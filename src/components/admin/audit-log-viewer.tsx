'use client';

import * as React from 'react';
import { ChevronDown, ChevronRight, Lock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuditLogs } from '@/hooks/use-admin';

const PAGE_SIZE = 25;

const ACTION_FILTERS = [
  'all',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.password_changed',
  'user.created',
  'user.activated',
  'user.deactivated',
  'user.role_granted',
  'user.role_revoked',
  'department.created',
  'department.updated',
];

function severityVariant(severity: string) {
  if (severity === 'critical') return 'destructive' as const;
  if (severity === 'warning') return 'warning' as const;
  if (severity === 'notice') return 'secondary' as const;
  return 'outline' as const;
}

export function AuditLogViewer() {
  const [page, setPage] = React.useState(1);
  const [action, setAction] = React.useState('all');
  const [outcome, setOutcome] = React.useState('all');
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const { data, isPending, isError, error } = useAuditLogs({ page, pageSize: PAGE_SIZE, action, outcome });
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
              Audit log
            </CardTitle>
            <CardDescription>
              Append-only. Entries cannot be edited or deleted by anyone, including administrators.
            </CardDescription>
          </div>

          <div className="flex gap-2">
            <Select
              value={action}
              onValueChange={(value) => {
                setAction(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-56" aria-label="Filter by action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTION_FILTERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value === 'all' ? 'All actions' : value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={outcome}
              onValueChange={(value) => {
                setOutcome(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-36" aria-label="Filter by outcome">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All outcomes</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="denied">Denied</SelectItem>
                <SelectItem value="error">Error</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {isPending
                ? Array.from({ length: 6 }, (_, index) => (
                    <TableRow key={`skeleton-${index}`}>
                      <TableCell colSpan={7}>
                        <Skeleton className="h-7 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                : null}

              {isError ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm">
                    <p className="font-medium text-destructive">Could not load the audit log</p>
                    <p className="mt-1 text-muted-foreground">
                      {error instanceof Error ? error.message : 'Unknown error'}
                    </p>
                  </TableCell>
                </TableRow>
              ) : null}

              {!isPending && !isError && (data?.items.length ?? 0) === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    No entries match these filters.
                  </TableCell>
                </TableRow>
              ) : null}

              {data?.items.map((entry) => (
                <React.Fragment key={entry.id}>
                  <TableRow>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={expanded === entry.id ? 'Hide details' : 'Show details'}
                        onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                      >
                        {expanded === entry.id ? (
                          <ChevronDown className="size-4" />
                        ) : (
                          <ChevronRight className="size-4" />
                        )}
                      </Button>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-sm">{entry.actorEmail ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={severityVariant(entry.severity)} className="font-mono text-[11px]">
                        {entry.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-sm">
                      {entry.entityLabel ?? entry.entityType}
                    </TableCell>
                    <TableCell>
                      <Badge variant={entry.outcome === 'success' ? 'outline' : 'destructive'}>
                        {entry.outcome}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{entry.ip}</TableCell>
                  </TableRow>

                  {expanded === entry.id ? (
                    <TableRow>
                      <TableCell colSpan={7} className="bg-muted/40">
                        <dl className="grid gap-2 py-2 text-xs sm:grid-cols-2">
                          <div>
                            <dt className="font-medium">Entity</dt>
                            <dd className="text-muted-foreground">
                              {entry.entityType} {entry.entityId ? `· ${entry.entityId}` : ''}
                            </dd>
                          </div>
                          {entry.reason ? (
                            <div>
                              <dt className="font-medium">Reason</dt>
                              <dd className="text-muted-foreground">{entry.reason}</dd>
                            </div>
                          ) : null}
                          {entry.previousValue ? (
                            <div className="sm:col-span-2">
                              <dt className="font-medium">Before</dt>
                              <dd>
                                <pre className="mt-1 overflow-x-auto rounded bg-background p-2">
                                  {JSON.stringify(entry.previousValue, null, 2)}
                                </pre>
                              </dd>
                            </div>
                          ) : null}
                          {entry.newValue ? (
                            <div className="sm:col-span-2">
                              <dt className="font-medium">After</dt>
                              <dd>
                                <pre className="mt-1 overflow-x-auto rounded bg-background p-2">
                                  {JSON.stringify(entry.newValue, null, 2)}
                                </pre>
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{data ? `${data.total} entries` : ''}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span>
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
