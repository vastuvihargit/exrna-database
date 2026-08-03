'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/api-client';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import {
  useBeginConnect,
  useMigration,
  useMigrationItems,
  usePauseMigration,
  useRetryMigration,
  useRunMigration,
  useScanMigration,
  type MigrationItemStatus,
} from '@/hooks/use-migrations';
import { STATUS_TONE } from './migrations-manager';

const ITEM_TONE: Record<MigrationItemStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  pending: 'outline',
  importing: 'secondary',
  imported: 'default',
  skipped_duplicate: 'secondary',
  skipped_unsupported: 'secondary',
  needs_review: 'secondary',
  failed: 'destructive',
};

/**
 * One migration, run step by step.
 *
 * The steps are separate on purpose. Connect, then scan, then import — an administrator
 * sees exactly what is about to be copied before a single byte moves, and the scan is
 * read-only so pressing it commits to nothing.
 */
export function MigrationDetail({ jobId }: { jobId: string }) {
  const [running, setRunning] = React.useState(false);
  const job = useMigration(jobId, { poll: running });
  const items = useMigrationItems(jobId);

  const beginConnect = useBeginConnect();
  const scan = useScanMigration();
  const run = useRunMigration();
  const pause = usePauseMigration();
  const retry = useRetryMigration();

  if (job.isLoading) return <Skeleton className="h-96 w-full" />;
  if (job.error) {
    return (
      <p className="text-sm text-destructive">
        {job.error instanceof ApiError ? job.error.message : 'Could not load this migration.'}
      </p>
    );
  }
  if (!job.data) return null;

  const data = job.data;
  const busy = scan.isPending || run.isPending || pause.isPending || retry.isPending;

  /**
   * Imports in bounded batches until nothing is left or something needs attention.
   *
   * The loop is on the client so progress is visible and the administrator can stop it;
   * each request is independently complete, so closing the tab pauses the migration
   * rather than corrupting it.
   */
  const importAll = async () => {
    setRunning(true);
    try {
      for (;;) {
        const result = await run.mutateAsync({ jobId, limit: 25 });
        if (result.remaining === 0 || result.processed === 0) {
          toast.success(
            `Imported ${result.imported}, skipped ${result.skippedDuplicates + result.skippedUnsupported}, failed ${result.failed}`,
          );
          break;
        }
      }
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'The import stopped');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1">
            <Link href="/admin/migrations">
              <ArrowLeft className="mr-2 size-3.5" aria-hidden="true" />
              All migrations
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">{data.name}</h2>
            <Badge variant={STATUS_TONE[data.status]}>{data.status.replace(/_/g, ' ')}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.connection.connected
              ? `Connected as ${data.connection.accountEmail ?? 'a Google account'} · read-only access`
              : 'Not connected to a Google account yet.'}
          </p>
        </div>
      </div>

      {data.lastError ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {data.lastError}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Scanned" value={String(data.counters.scannedFiles)} />
        <Tile label="Imported" value={String(data.counters.imported)} />
        <Tile
          label="Skipped"
          value={String(data.counters.skippedDuplicates + data.counters.skippedUnsupported)}
        />
        <Tile label="Failed" value={String(data.counters.failed)} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Run</CardTitle>
          <CardDescription>
            Connect, scan, then import. The scan reads Drive and writes nothing to it; nothing is
            copied until you press Import.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant={data.connection.connected ? 'outline' : 'default'}
            size="sm"
            disabled={busy}
            onClick={async () => {
              try {
                const start = await beginConnect.mutateAsync(jobId);
                // The state is echoed back by the callback page and checked server-side.
                window.sessionStorage.setItem('migration-connect-state', start.state);
                window.location.href = start.authorizationUrl;
              } catch (error) {
                toast.error(
                  error instanceof ApiError ? error.message : 'Could not start the connection',
                );
              }
            }}
          >
            <ShieldCheck className="mr-2 size-3.5" aria-hidden="true" />
            {data.connection.connected ? 'Reconnect' : 'Connect Google account'}
          </Button>

          <Button
            variant="outline"
            size="sm"
            disabled={busy || !data.connection.connected}
            onClick={async () => {
              try {
                const result = await scan.mutateAsync(jobId);
                toast.success(
                  `Scanned ${result.files} files in ${result.folders} folders (${formatBytes(result.bytes)})`,
                  result.truncated
                    ? { description: 'The scan hit its size limit — narrow the source folders.' }
                    : undefined,
                );
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : 'The scan failed');
              }
            }}
          >
            <Search className="mr-2 size-3.5" aria-hidden="true" />
            {scan.isPending ? 'Scanning…' : 'Scan Drive'}
          </Button>

          <Button size="sm" disabled={busy || running} onClick={importAll}>
            <Play className="mr-2 size-3.5" aria-hidden="true" />
            {running ? 'Importing…' : 'Import'}
          </Button>

          <Button
            variant="outline"
            size="sm"
            disabled={pause.isPending}
            onClick={async () => {
              setRunning(false);
              await pause.mutateAsync(jobId).catch(() => undefined);
              toast.success('Migration paused');
            }}
          >
            <Pause className="mr-2 size-3.5" aria-hidden="true" />
            Pause
          </Button>

          <Button
            variant="ghost"
            size="sm"
            disabled={busy || running}
            onClick={async () => {
              try {
                const result = await retry.mutateAsync(jobId);
                toast.success(
                  result.requeued > 0
                    ? `${result.requeued} item${result.requeued === 1 ? '' : 's'} queued again`
                    : 'Nothing to retry',
                );
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : 'Could not retry');
              }
            }}
          >
            <RefreshCw className="mr-2 size-3.5" aria-hidden="true" />
            Retry failed
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Items</CardTitle>
          <CardDescription>
            Every scanned file, and what happened to it — including the ones that were skipped.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {items.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (items.data?.length ?? 0) === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing scanned yet. Connect an account and run a scan.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Source path</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.data?.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="max-w-[16rem]">
                        <p className="truncate font-medium">{item.name}</p>
                        {item.lastError ? (
                          <p className="truncate text-xs text-destructive">{item.lastError}</p>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-[18rem] truncate text-xs text-muted-foreground">
                        {item.sourcePath}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs tabular-nums">
                        {formatBytes(item.importedBytes || item.declaredSize)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={ITEM_TONE[item.status]} className="gap-1 whitespace-nowrap">
                          {item.status === 'imported' ? (
                            <CheckCircle2 className="size-3" aria-hidden="true" />
                          ) : item.status === 'skipped_duplicate' ? (
                            <Copy className="size-3" aria-hidden="true" />
                          ) : null}
                          {item.status.replace(/_/g, ' ')}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      <p className="text-xs text-muted-foreground">
        Original Google Drive content is never changed by this platform. The connection requests
        read-only access and the client has no method that can write. Imported files record where
        they came from, and every import is in the audit log.
        {data.scanCompletedAt
          ? ` Last scan ${formatRelativeTime(data.scanCompletedAt)}.`
          : ''}
      </p>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}
