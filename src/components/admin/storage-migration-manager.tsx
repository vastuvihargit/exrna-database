'use client';

import * as React from 'react';
import { AlertTriangle, CloudUpload, Play, Pause, RotateCcw, ShieldCheck, Undo2 } from 'lucide-react';
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
import { formatBytes } from '@/lib/utils';
import { useDrives } from '@/hooks/use-drive';
import {
  useCreateStorageJob,
  usePauseStorageJob,
  usePlanStorageJob,
  useRetryStorageJob,
  useRollbackStorageJob,
  useRunStorageJob,
  useStorageJob,
  useStorageJobItems,
  useStorageJobs,
  useVerifyStorageJob,
  type PlanReportDto,
  type StorageJobStatus,
} from '@/hooks/use-storage-migration';

const STATUS_TONE: Record<StorageJobStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  draft: 'outline',
  planning: 'secondary',
  planned: 'secondary',
  running: 'default',
  paused: 'outline',
  completed: 'default',
  completed_with_failures: 'destructive',
  failed: 'destructive',
  cancelled: 'outline',
};

/** Codes are for machines; this is what an administrator can act on. */
const FAILURE_EXPLANATIONS: Record<string, string> = {
  LOCAL_MISSING: 'The file is not on this server. It may already have been removed.',
  LOCAL_CORRUPT: 'The file on disk no longer matches its recorded checksum — it was not uploaded.',
  VERIFY_MISMATCH: 'What arrived in Drive did not match what was sent. The copy was removed.',
  DRIVE_QUOTA_EXCEEDED: 'The Shared Drive is out of space.',
  DRIVE_PERMISSION_DENIED: 'The service account is not allowed to write here.',
  DRIVE_RATE_LIMITED: 'Google asked us to slow down. Retry in a few minutes.',
  FOLDER_TOO_DEEP: 'The folder is nested deeper than Google Drive allows (20 levels).',
  FOLDER_MAPPING_FAILED: 'The destination folder could not be created in Drive.',
  DATABASE_WRITE_FAILED: 'The file reached Drive but this system could not record it. It will be reconciled.',
  DRIVE_UPLOAD_FAILED: 'The transfer did not complete.',
  UNKNOWN: 'The transfer failed for an unrecognised reason.',
};

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
}

export function StorageMigrationManager() {
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [showFailedOnly, setShowFailedOnly] = React.useState(false);
  const [plan, setPlan] = React.useState<PlanReportDto | null>(null);

  const jobs = useStorageJobs();
  const detail = useStorageJob(selectedJobId, {
    poll: Boolean(selectedJobId),
  });
  const items = useStorageJobItems(selectedJobId, showFailedOnly);

  const planJob = usePlanStorageJob();
  const runJob = useRunStorageJob();
  const pauseJob = usePauseStorageJob();
  const retryJob = useRetryStorageJob();
  const verifyJob = useVerifyStorageJob();
  const rollback = useRollbackStorageJob();

  const busy =
    planJob.isPending || runJob.isPending || verifyJob.isPending || rollback.isPending;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">Move files to the Shared Drive</CardTitle>
            <CardDescription>
              Files stay on this server until a job has moved them and confirmed the copy matches.
              Local copies are kept afterwards so anything can be put back.
            </CardDescription>
          </div>
          <Button onClick={() => setCreating(true)} size="sm">
            <CloudUpload className="mr-2 size-4" aria-hidden="true" />
            New job
          </Button>
        </CardHeader>
        <CardContent>
          {jobs.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : jobs.data && jobs.data.length > 0 ? (
            <ul className="divide-y">
              {jobs.data.map((job) => (
                <li key={job.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedJobId(job.id);
                      setPlan(null);
                    }}
                    aria-current={selectedJobId === job.id}
                    className="flex w-full flex-wrap items-center gap-3 py-3 text-left hover:bg-muted/50 aria-[current=true]:bg-muted/50"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{job.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {job.mode === 'dry_run' ? 'Dry run' : job.mode.replace('_', ' ')}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {job.counters.verified}/{job.counters.selected} moved
                    </span>
                    {job.counters.failed > 0 ? (
                      <Badge variant="destructive">{job.counters.failed} failed</Badge>
                    ) : null}
                    <Badge variant={STATUS_TONE[job.status]}>{job.status.replace(/_/g, ' ')}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-sm text-muted-foreground">
              No jobs yet. Start with a dry run over one folder to see what it would move.
            </p>
          )}
        </CardContent>
      </Card>

      {selectedJobId && detail.data ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{detail.data.job.name}</CardTitle>
            <CardDescription>
              {detail.data.job.mode === 'dry_run'
                ? 'A dry run. Nothing is moved and nothing is recorded.'
                : 'Files are copied, checked, and only then recorded as moved.'}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Selected" value={String(detail.data.job.counters.selected)} />
              <Stat label="Total size" value={formatBytes(detail.data.job.counters.selectedBytes)} />
              <Stat label="Moved &amp; checked" value={String(detail.data.job.counters.verified)} />
              <Stat
                label="Failed"
                value={String(detail.data.job.counters.failed)}
                tone={detail.data.job.counters.failed > 0 ? 'bad' : 'normal'}
              />
              <Stat label="Skipped" value={String(detail.data.job.counters.skipped)} />
              <Stat label="Transferred" value={formatBytes(detail.data.job.counters.uploadedBytes)} />
              <Stat
                label="Remaining"
                value={String(
                  Math.max(
                    0,
                    detail.data.job.counters.selected -
                      detail.data.job.counters.verified -
                      detail.data.job.counters.failed,
                  ),
                )}
              />
              <Stat label="Put back" value={String(detail.data.job.counters.rolledBack)} />
            </div>

            {detail.data.openRecoveries > 0 ? (
              <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                <span>
                  {detail.data.openRecoveries} transfer(s) did not finish cleanly and are waiting to be
                  reconciled. Nothing has been lost — retrying is safe and will not create duplicates.
                </span>
              </p>
            ) : null}

            {detail.data.job.lastError ? (
              <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
                {detail.data.job.lastError}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  planJob.mutate(selectedJobId, {
                    onSuccess: (report) => {
                      setPlan(report);
                      toast.success(`${report.selected} file version(s) selected`);
                    },
                    onError: (error) => toast.error(errorMessage(error)),
                  })
                }
              >
                <ShieldCheck className="mr-2 size-4" aria-hidden="true" />
                Check what would move
              </Button>

              {detail.data.job.mode !== 'dry_run' ? (
                <>
                  <Button
                    size="sm"
                    disabled={busy || detail.data.job.status === 'running'}
                    onClick={() =>
                      runJob.mutate(selectedJobId, {
                        onSuccess: (result) =>
                          toast.success(
                            `Moved ${result.verified}${result.failed > 0 ? `, ${result.failed} failed` : ''}` +
                              (result.stoppedBecause === 'limit' ? ' — run again to continue' : ''),
                          ),
                        onError: (error) => toast.error(errorMessage(error)),
                      })
                    }
                  >
                    <Play className="mr-2 size-4" aria-hidden="true" />
                    {detail.data.job.status === 'paused' ? 'Continue' : 'Start moving'}
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pauseJob.isPending}
                    onClick={() =>
                      pauseJob.mutate(selectedJobId, {
                        onSuccess: () => toast.success('Pausing after the current file'),
                        onError: (error) => toast.error(errorMessage(error)),
                      })
                    }
                  >
                    <Pause className="mr-2 size-4" aria-hidden="true" />
                    Pause
                  </Button>

                  {detail.data.job.counters.failed > 0 ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        retryJob.mutate(selectedJobId, {
                          onSuccess: (result) =>
                            toast.success(`${result.requeued} file(s) queued to try again`),
                          onError: (error) => toast.error(errorMessage(error)),
                        })
                      }
                    >
                      <RotateCcw className="mr-2 size-4" aria-hidden="true" />
                      Try failed again
                    </Button>
                  ) : null}

                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      verifyJob.mutate(selectedJobId, {
                        onSuccess: (result) =>
                          result.failed > 0
                            ? toast.error(`${result.failed} of ${result.checked} no longer match`)
                            : toast.success(`All ${result.checked} checked and correct`),
                        onError: (error) => toast.error(errorMessage(error)),
                      })
                    }
                  >
                    Re-check moved files
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || detail.data.job.counters.verified === 0}
                    onClick={() =>
                      rollback.mutate(selectedJobId, {
                        onSuccess: (result) =>
                          result.skipped > 0
                            ? toast.error(
                                `Put back ${result.rolledBack}; ${result.skipped} could not be — their local copies are gone`,
                              )
                            : toast.success(`Put ${result.rolledBack} file(s) back on this server`),
                        onError: (error) => toast.error(errorMessage(error)),
                      })
                    }
                  >
                    <Undo2 className="mr-2 size-4" aria-hidden="true" />
                    Put files back
                  </Button>
                </>
              ) : null}
            </div>

            {plan ? <PlanSummary plan={plan} /> : null}

            {Object.keys(detail.data.job.failureCounts).length > 0 ? (
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Why files failed</h3>
                <ul className="space-y-1 text-sm">
                  {Object.entries(detail.data.job.failureCounts).map(([code, count]) => (
                    <li key={code} className="flex items-start justify-between gap-3">
                      <span className="text-muted-foreground">
                        {FAILURE_EXPLANATIONS[code] ?? code}
                      </span>
                      <span className="shrink-0 tabular-nums">{count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Files</h3>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={showFailedOnly}
                    onChange={(event) => setShowFailedOnly(event.target.checked)}
                  />
                  Only show failures
                </label>
              </div>

              {items.data && items.data.length > 0 ? (
                <ul className="divide-y text-sm">
                  {items.data.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                      <span className="min-w-0 flex-1 truncate">{item.displayName}</span>
                      <span className="text-xs text-muted-foreground">v{item.versionNumber}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {formatBytes(item.sizeBytes)}
                      </span>
                      <Badge variant={item.status === 'failed' ? 'destructive' : 'outline'}>
                        {item.status.replace(/_/g, ' ')}
                      </Badge>
                      {item.failureCode ? (
                        <p className="w-full pt-1 text-xs text-muted-foreground">
                          {FAILURE_EXPLANATIONS[item.failureCode] ?? item.failureDetail}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-sm text-muted-foreground">
                  {showFailedOnly ? 'No failures.' : 'Nothing planned yet.'}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <CreateJobDialog open={creating} onOpenChange={setCreating} onCreated={setSelectedJobId} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'normal' | 'bad' }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${tone === 'bad' ? 'text-destructive' : ''}`}>
        {value}
      </p>
    </div>
  );
}

/**
 * The pre-flight report.
 *
 * The two warnings are the external ceilings nobody can raise — the Shared Drive item limit
 * and Drive's folder depth. Finding out about either half way through a migration is far
 * more expensive than reading it here.
 */
function PlanSummary({ plan }: { plan: PlanReportDto }) {
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p>
        <span className="font-medium">{plan.selected}</span> file version(s) across{' '}
        {plan.distinctFolders} folder(s), {formatBytes(plan.selectedBytes)} in total.
        {plan.alreadyMigrated > 0 ? ` ${plan.alreadyMigrated} already moved.` : ''}
        {plan.skippedNative > 0 ? ` ${plan.skippedNative} Google document(s) skipped.` : ''}
      </p>

      {!plan.itemProjection.withinLimit ? (
        <p className="text-destructive">
          This would exceed the Shared Drive limit of {plan.itemProjection.limit.toLocaleString('en-GB')}{' '}
          items. The migration cannot complete as planned.
        </p>
      ) : plan.itemProjection.approachingLimit ? (
        <p className="text-warning">
          The Shared Drive would hold {plan.itemProjection.projectedItems.toLocaleString('en-GB')} of a
          maximum {plan.itemProjection.limit.toLocaleString('en-GB')} items. Plan for a second drive
          before continuing.
        </p>
      ) : null}

      {plan.tooDeep.length > 0 ? (
        <div className="text-destructive">
          <p>{plan.tooDeep.length} folder(s) are nested too deeply for Google Drive:</p>
          <ul className="mt-1 list-inside list-disc">
            {plan.tooDeep.slice(0, 5).map((folder) => (
              <li key={folder.id}>
                {folder.name} — {folder.depth} levels
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function CreateJobDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = React.useState('');
  const [folderId, setFolderId] = React.useState('');
  const [dryRun, setDryRun] = React.useState(true);
  const drives = useDrives();
  const create = useCreateStorageJob();

  /**
   * A department whose drive root has never been created has nothing in it to move, so it
   * is not offered — an option that produces an empty job is worse than no option.
   */
  const departments = (drives.data?.departments ?? []).filter(
    (department): department is typeof department & { rootFolderId: string } =>
      typeof department.rootFolderId === 'string',
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New migration job</DialogTitle>
          <DialogDescription>
            Choose one area to start with. Small first, and always a dry run before the real thing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="job-name">Name</Label>
            <Input
              id="job-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Analytical Chemistry — first batch"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="job-folder">Folder to move</Label>
            <select
              id="job-folder"
              value={folderId}
              onChange={(event) => setFolderId(event.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">Select a department drive…</option>
              {departments.map((department) => (
                <option key={department.rootFolderId} value={department.rootFolderId}>
                  {department.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">Everything inside it is included.</p>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(event) => setDryRun(event.target.checked)}
              className="mt-1"
            />
            <span>
              Dry run — work out what would move and report any problems, without moving anything.
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || !folderId || create.isPending}
            onClick={() =>
              create.mutate(
                {
                  name: name.trim(),
                  mode: dryRun ? 'dry_run' : 'migrate',
                  selection: { folderIds: [folderId], includeDescendants: true },
                },
                {
                  onSuccess: (job) => {
                    onCreated(job.id);
                    onOpenChange(false);
                    setName('');
                    setFolderId('');
                    toast.success('Job created. Check what would move before starting.');
                  },
                  onError: (error) => toast.error(errorMessage(error)),
                },
              )
            }
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
