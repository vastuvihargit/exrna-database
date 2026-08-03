'use client';

import { AlertTriangle, CheckCircle2, Database, HardDrive, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useHealth } from '@/hooks/use-health';
import { formatBytes } from '@/lib/utils';

function StatusIcon({ status }: { status: 'ok' | 'degraded' | 'error' }) {
  if (status === 'ok') return <CheckCircle2 className="size-4 text-success" aria-hidden="true" />;
  if (status === 'degraded') return <AlertTriangle className="size-4 text-warning" aria-hidden="true" />;
  return <XCircle className="size-4 text-destructive" aria-hidden="true" />;
}

export function SystemStatusCard() {
  const { data, isPending, isError, error, refetch } = useHealth();

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">System status</CardTitle>
          <CardDescription>Database connection and private storage volume</CardDescription>
        </div>
        {data ? (
          <Badge variant={data.status === 'ok' ? 'success' : data.status === 'degraded' ? 'warning' : 'destructive'}>
            {data.status === 'ok' ? 'Healthy' : data.status === 'degraded' ? 'Degraded' : 'Unhealthy'}
          </Badge>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Loading state */}
        {isPending ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : null}

        {/* Error state */}
        {isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <p className="font-medium text-destructive">Could not reach the health endpoint</p>
            <p className="mt-1 text-muted-foreground">
              {error instanceof Error ? error.message : 'Unknown error'}
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="mt-3 text-sm font-medium text-primary underline underline-offset-4"
            >
              Retry
            </button>
          </div>
        ) : null}

        {/* Populated state */}
        {data ? (
          <>
            <div className="flex items-start gap-3 rounded-md border p-3">
              <Database className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">MongoDB</span>
                  <StatusIcon status={data.checks.database.status === 'ok' ? 'ok' : 'error'} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {data.checks.database.status === 'ok'
                    ? `${data.checks.database.database} · ping ${data.checks.database.latencyMs} ms`
                    : (data.checks.database.error ?? 'Not connected')}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-md border p-3">
              <HardDrive className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Private file storage</span>
                  <StatusIcon status={data.checks.storage.status} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {data.checks.storage.writable
                    ? `${data.checks.storage.provider} provider · write/read verified`
                    : (data.checks.storage.error ?? 'Not writable')}
                  {data.checks.storage.freeBytes !== undefined
                    ? ` · ${formatBytes(data.checks.storage.freeBytes)} free (${data.checks.storage.freePercent}%)`
                    : ''}
                </p>
                {data.checks.storage.belowFreeSpaceFloor ? (
                  <p className="mt-1 text-xs font-medium text-warning">
                    Free space is below the configured floor — uploads will be refused.
                  </p>
                ) : null}
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Environment: {data.environment} · uptime {Math.floor(data.uptimeSeconds / 60)} min
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
