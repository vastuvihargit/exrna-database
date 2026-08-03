import type { Metadata } from 'next';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  DatabaseZap,
  HardDrive,
  ShieldCheck,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatBytes } from '@/lib/utils';
import { requireActor } from '@/server/http/page-guard';
import { systemService } from '@/server/services/system.service';
import type { Severity } from '@/server/services/system-checks';

export const metadata: Metadata = { title: 'System status' };
export const dynamic = 'force-dynamic';

/**
 * The page that answers "is anything quietly broken?".
 *
 * Server component calling the same permission-checked service the API uses, so it
 * cannot render a figure the viewer is not entitled to. `getSystemStatus` throws for
 * anyone without company-scoped `audit.view`; the admin layout has already redirected
 * anyone without any administrative grant, and this is the second gate.
 */
export default async function SystemStatusPage() {
  const actor = await requireActor('/admin/system');

  let status;
  try {
    status = await systemService.getSystemStatus(actor);
  } catch {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">System status</CardTitle>
          <CardDescription>
            Viewing system status needs company-wide audit permission. A department-scoped
            administrator manages people and folders, not the server.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const summary = SEVERITY_SUMMARY[status.status];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">{summary.title}</CardTitle>
            <CardDescription>{summary.description}</CardDescription>
          </div>
          <Badge variant={BADGE_VARIANT[status.status]}>{status.status.toUpperCase()}</Badge>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {status.checks.map((check) => (
              <li key={check.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <SeverityIcon severity={check.severity} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <p className="text-sm font-medium">{check.label}</p>
                    {check.value ? (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {check.value}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">{check.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <HardDrive className="size-4 text-muted-foreground" aria-hidden="true" />
              Storage volume
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row
              label="Free"
              value={
                status.storage.freeBytes !== null
                  ? `${formatBytes(status.storage.freeBytes)}${
                      status.storage.freePercent !== null
                        ? ` (${status.storage.freePercent.toFixed(1)}%)`
                        : ''
                    }`
                  : 'unknown'
              }
            />
            <Row
              label="Total"
              value={
                status.storage.totalBytes !== null
                  ? formatBytes(status.storage.totalBytes)
                  : 'unknown'
              }
            />
            <Row label="Upload floor" value={formatBytes(status.storage.minFreeBytes)} />
            <Row
              label="Stored objects"
              value={status.storage.storedObjects.toLocaleString('en-GB')}
            />
            <p className="pt-1 text-xs text-muted-foreground">
              Uploads are refused once free space would fall below the floor — a full disk
              corrupts writes, so the system stops before it gets there.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <DatabaseZap className="size-4 text-muted-foreground" aria-hidden="true" />
              Backups
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row
              label="Last run"
              value={
                status.backup.lastRunAt
                  ? `${status.backup.lastRunAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`
                  : 'never'
              }
            />
            <Row
              label="Result"
              value={status.backup.ok === null ? 'unknown' : status.backup.ok ? 'succeeded' : 'FAILED'}
            />
            <Row label="Verified" value={status.backup.verified ? 'yes' : 'no'} />
            <Row label="Off-server copy" value={status.backup.offsite ? 'yes' : 'NO'} />
            <Row
              label="Restore drill"
              value={
                status.backup.lastDrillAt
                  ? `${status.backup.lastDrillAt.toISOString().slice(0, 10)}${
                      status.backup.lastDrillOk === false ? ' (failed)' : ''
                    }`
                  : 'never'
              }
            />
            {status.backup.detail ? (
              <p className="pt-1 text-xs text-muted-foreground">{status.backup.detail}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
              Uploads &amp; scanning
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Quarantined" value={String(status.uploads.quarantined)} />
            <Row label="Failed" value={String(status.uploads.failed)} />
            <Row label="Rejected" value={String(status.uploads.rejected)} />
            <Row label="In flight" value={String(status.uploads.stale)} />
            <Row
              label="Antivirus"
              value={
                !status.malwareScanning.enabled
                  ? 'not configured'
                  : status.malwareScanning.reachable
                    ? status.malwareScanning.scanner
                    : 'UNREACHABLE'
              }
            />
            {status.malwareScanning.enabled ? (
              <p className="pt-1 text-xs text-muted-foreground">
                {status.malwareScanning.failClosed
                  ? 'Fail-closed: an unreachable scanner refuses uploads rather than accepting them unscanned.'
                  : 'Fail-open: uploads are accepted when the scanner cannot be reached.'}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/*
        Shown only when the backend is switched on. A permanently-present panel reading
        "not configured" on every deployment that will never use it is noise, and noise on
        a status page is how the lines that matter stop being read.

        This is the one place in the product where Drive identifiers appear at all. §19 of
        the migration brief keeps them out of every employee-facing surface; here they are
        exactly what somebody needs in order to fix a broken connection, and the page is
        already behind company-scoped `audit.view`.
      */}
      {status.driveStorage.enabled ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Cloud className="size-4 text-muted-foreground" aria-hidden="true" />
              Google Shared Drive
            </CardTitle>
            <CardDescription>
              {status.driveStorage.isDefaultProvider
                ? 'New files are stored here. Files uploaded before the switch are served from wherever they were stored.'
                : 'Connected for migration. New files are still stored on this server.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-2">
            <Row
              label="Connection"
              value={status.driveStorage.connected ? (status.driveStorage.driveName ?? 'connected') : 'NOT CONNECTED'}
            />
            <Row label="Drive ID" value={status.driveStorage.sharedDriveId ?? 'not set'} />
            <Row label="Root folder" value={status.driveStorage.rootFolderId ?? 'drive root'} />
            <Row label="Service account" value={status.driveStorage.serviceAccountEmail ?? 'not set'} />
            <Row
              label="Key source"
              value={status.driveStorage.keySource === 'file' ? 'mounted secret' : (status.driveStorage.keySource ?? 'none')}
            />
            <Row label="New uploads go to" value={status.driveStorage.isDefaultProvider ? 'Shared Drive' : 'this server'} />

            {status.driveStorage.error ? (
              <p className="pt-1 text-xs text-destructive md:col-span-2">{status.driveStorage.error}</p>
            ) : null}
            {status.driveStorage.warnings.map((warning) => (
              <p key={warning} className="pt-1 text-xs text-warning md:col-span-2">
                {warning}
              </p>
            ))}

            {/*
              Said plainly because the Drive activity pane will mislead anyone who reads it:
              one service account performs every write, so Drive's own "last modified by" is
              the same name on every file. The application audit log is the real attribution.
            */}
            <p className="pt-1 text-xs text-muted-foreground md:col-span-2">
              Every change is made by the service account above, so Google&rsquo;s own
              &ldquo;last modified by&rdquo; shows that one name on every file. Who actually did what is
              in the audit log, not in Drive.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Generated {status.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC. The same
        checks run every 15 minutes in the scheduler container and raise alerts without waiting for
        anyone to open this page.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function SeverityIcon({ severity }: { severity: Severity }) {
  if (severity === 'critical') {
    return <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Critical" />;
  }
  if (severity === 'warning') {
    return <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Warning" />;
  }
  return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Healthy" />;
}

const BADGE_VARIANT: Record<Severity, 'success' | 'warning' | 'destructive'> = {
  ok: 'success',
  warning: 'warning',
  critical: 'destructive',
};

const SEVERITY_SUMMARY: Record<Severity, { title: string; description: string }> = {
  ok: {
    title: 'Everything checks out',
    description: 'Storage, backups, scanning and the database are all in a healthy state.',
  },
  warning: {
    title: 'Something needs attention today',
    description: 'Nothing is failing right now, but one or more conditions will become a problem.',
  },
  critical: {
    title: 'Something is wrong now',
    description:
      'At least one condition is actively causing failures or leaving research data unprotected.',
  },
};
