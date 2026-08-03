'use client';

import Link from 'next/link';
import {
  Building2,
  CheckCircle2,
  FlaskConical,
  FolderOpen,
  HardDrive,
  Users,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import { useProjectOverview } from '@/hooks/use-research';
import { DriveError } from '@/components/drive/drive-browser';
import { ExperimentList } from './experiment-list';

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  protocol: 'Protocols',
  sop: 'SOPs',
  raw_data: 'Raw data',
  processed_data: 'Processed data',
  analysis: 'Analysis',
  result: 'Results',
  report: 'Reports',
  proposal: 'Proposals',
  presentation: 'Presentations',
  certificate: 'Certificates',
  approval: 'Approvals',
  other: 'Other',
  unclassified: 'Not classified',
};

/**
 * The project dashboard.
 *
 * Answers the question the brief opens with — "what is the complete history of this
 * research project?" — with the four things that make it answerable: what is in it, what
 * produced it, who is on it, and what happened recently.
 *
 * Every number here is computed over what *this viewer* can open, which is why two
 * members can legitimately see different totals.
 */
export function ProjectOverview({ projectId }: { projectId: string }) {
  const overview = useProjectOverview(projectId);

  if (overview.error) return <DriveError error={overview.error} />;
  if (overview.isLoading || !overview.data) return <OverviewSkeleton />;

  const { project, department, members, content, experiments, activity, missingTemplateFolders } =
    overview.data;

  const approved = content.byReviewStatus.find((row) => row.value === 'approved')?.count ?? 0;
  const inReview = content.byReviewStatus
    .filter((row) => row.value === 'submitted' || row.value === 'in_review')
    .reduce((sum, row) => sum + row.count, 0);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
            <Badge variant="secondary">{project.code}</Badge>
            <Badge variant="outline">{project.status.replace('_', ' ')}</Badge>
          </div>
          <p className="mt-1 text-muted-foreground">
            {project.description || 'No project description recorded.'}
          </p>
          {department ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Building2 className="size-3.5" aria-hidden="true" />
              {department.name}
            </p>
          ) : null}
        </div>

        {project.rootFolderId ? (
          <Button asChild variant="outline">
            <Link href={`/projects/${project.id}`}>
              <FolderOpen className="mr-2 size-4" aria-hidden="true" />
              Open drive
            </Link>
          </Button>
        ) : null}
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Files you can see" value={String(content.totalFiles)} icon={FolderOpen} />
        <Tile label="Storage used" value={formatBytes(content.totalBytes)} icon={HardDrive} />
        <Tile label="Experiments" value={String(experiments.total)} icon={FlaskConical} />
        <Tile label="Approved files" value={String(approved)} icon={CheckCircle2} />
      </div>

      {missingTemplateFolders.length > 0 ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">This drive is missing template folders</CardTitle>
            <CardDescription>
              These folders are part of the standard project structure but are not in this drive.
              Nothing has been created automatically — an existing drive is never rewritten by a
              template change.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1.5">
            {missingTemplateFolders.map((folder) => (
              <Badge key={folder.key} variant="outline">
                {folder.name}
              </Badge>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Research data by type</CardTitle>
            <CardDescription>
              Raw, processed, analysis and reporting — as classified on each file.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {content.byDocumentType.length === 0 ? (
              <p className="text-sm text-muted-foreground">No files yet.</p>
            ) : (
              <ul className="space-y-2">
                {content.byDocumentType.map((row) => (
                  <li key={row.value} className="flex items-center gap-3 text-sm">
                    <span className="w-40 shrink-0 truncate">
                      {DOCUMENT_TYPE_LABEL[row.value] ?? row.value}
                    </span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{
                          width: `${content.totalFiles > 0 ? Math.max(4, (row.count / content.totalFiles) * 100) : 0}%`,
                        }}
                      />
                    </span>
                    <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                      {row.count} · {formatBytes(row.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <Separator className="my-4" />

            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Under review</dt>
                <dd className="font-medium tabular-nums">{inReview}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Traced to an experiment</dt>
                <dd className="font-medium tabular-nums">{content.linkedToExperiment}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Team</dt>
                <dd className="font-medium tabular-nums">{members.length}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="size-4" aria-hidden="true" />
              Team
            </CardTitle>
            <CardDescription>Who can reach this project drive through membership.</CardDescription>
          </CardHeader>
          <CardContent>
            {members.length === 0 ? (
              <p className="text-sm text-muted-foreground">No members assigned.</p>
            ) : (
              <ul className="space-y-2">
                {members.map((member) => (
                  <li key={member.id} className="flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{member.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                    </div>
                    {member.isLead ? <Badge variant="secondary">Lead</Badge> : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <ExperimentList projectId={projectId} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent activity</CardTitle>
          <CardDescription>What has happened in this project.</CardDescription>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
          ) : (
            <ol className="space-y-2 text-sm">
              {activity.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{entry.actorName}</span>
                  <span className="text-muted-foreground">{entry.action.replace(/[._]/g, ' ')}</span>
                  <span className="truncate">{entry.entityLabel}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatRelativeTime(entry.createdAt)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof FolderOpen;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <p className="truncate text-2xl font-semibold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-16 w-2/3" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
