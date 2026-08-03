'use client';

import * as React from 'react';
import Link from 'next/link';
import { CloudDownload, Plus, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api-client';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import { useDrives } from '@/hooks/use-drive';
import { useCreateMigration, useMigrations, type MigrationStatus } from '@/hooks/use-migrations';

export const STATUS_TONE: Record<MigrationStatus, 'default' | 'secondary' | 'outline' | 'destructive'> =
  {
    draft: 'outline',
    connected: 'secondary',
    scanning: 'secondary',
    scanned: 'secondary',
    importing: 'default',
    paused: 'outline',
    needs_review: 'secondary',
    partially_completed: 'secondary',
    completed: 'default',
    failed: 'destructive',
  };

export function MigrationsManager() {
  const migrations = useMigrations();
  const [creating, setCreating] = React.useState(false);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <CloudDownload className="size-4" aria-hidden="true" />
              Google Drive migrations
            </CardTitle>
            <CardDescription>
              Import existing Drive content into this platform. Read-only throughout: nothing in
              Google Drive is renamed, moved or deleted, and the originals stay exactly as they are.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-2 size-3.5" aria-hidden="true" />
            New migration
          </Button>
        </CardHeader>

        <CardContent>
          {migrations.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : migrations.error ? (
            <p className="text-sm text-destructive">
              {migrations.error instanceof ApiError
                ? migrations.error.message
                : 'Could not load migrations.'}
            </p>
          ) : (migrations.data?.length ?? 0) === 0 ? (
            <div className="rounded-md border border-dashed p-10 text-center">
              <p className="font-medium">No migrations yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                A migration connects one Google account, scans the folders you select, and copies
                what it finds into a destination folder here.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {migrations.data?.map((job) => (
                <li key={job.id}>
                  <Link
                    href={`/admin/migrations/${job.id}`}
                    className="block rounded-md border p-4 transition-colors hover:border-primary/50 hover:bg-muted/40"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{job.name}</span>
                      <Badge variant={STATUS_TONE[job.status]}>
                        {job.status.replace(/_/g, ' ')}
                      </Badge>
                      {job.connection.connected ? (
                        <Badge variant="outline" className="gap-1">
                          <ShieldCheck className="size-3" aria-hidden="true" />
                          {job.connection.accountEmail ?? 'connected'}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {job.counters.imported} imported · {job.counters.skippedDuplicates} duplicates
                      skipped · {job.counters.failed} failed ·{' '}
                      {formatBytes(job.counters.importedBytes)} · created{' '}
                      {formatRelativeTime(job.createdAt)}
                    </p>
                    {job.lastError ? (
                      <p className="mt-1 text-xs text-destructive">{job.lastError}</p>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CreateMigrationDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function CreateMigrationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const drives = useDrives();
  const create = useCreateMigration();

  const [name, setName] = React.useState('');
  const [targetFolderId, setTargetFolderId] = React.useState('');
  const [sourceFolderIds, setSourceFolderIds] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setName('');
    setTargetFolderId('');
    setSourceFolderIds('');
  }, [open]);

  // Only drives that have been opened have a root folder to import into.
  const destinations = [
    ...(drives.data?.departments ?? []),
    ...(drives.data?.projects ?? []),
  ].filter((drive) => drive.rootFolderId);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await create.mutateAsync({
        name: name.trim(),
        targetFolderId,
        sourceFolderIds: sourceFolderIds
          .split(/[\s,]+/)
          .map((entry) => entry.trim())
          .filter(Boolean),
      });
      toast.success('Migration created', {
        description: 'Connect a Google account next, then scan before importing anything.',
      });
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not create the migration');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New Google Drive migration</DialogTitle>
            <DialogDescription>
              Imported files take the destination folder&rsquo;s classification, or stricter — an
              import never makes content more widely readable than the folder it lands in.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="migration-name">Name</Label>
              <Input
                id="migration-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Molecular Biology shared drive"
                maxLength={200}
                required
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="migration-target">Destination</Label>
              <select
                id="migration-target"
                value={targetFolderId}
                onChange={(event) => setTargetFolderId(event.target.value)}
                required
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Select a drive…</option>
                {destinations.map((drive) => (
                  <option key={drive.id} value={drive.rootFolderId!}>
                    {drive.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                You must be able to upload into this folder yourself. Only drives that have been
                opened at least once appear here.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="migration-sources">Google Drive folder IDs</Label>
              <Input
                id="migration-sources"
                value={sourceFolderIds}
                onChange={(event) => setSourceFolderIds(event.target.value)}
                placeholder="1AbC… 1XyZ…  (leave empty for the whole of My Drive)"
              />
              <p className="text-[11px] text-muted-foreground">
                The id is the last part of a Drive folder URL. Separate several with spaces or
                commas.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim() || !targetFolderId}>
              {create.isPending ? 'Creating…' : 'Create migration'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
