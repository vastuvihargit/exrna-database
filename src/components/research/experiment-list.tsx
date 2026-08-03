'use client';

import * as React from 'react';
import Link from 'next/link';
import { FlaskConical, Plus, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelativeTime } from '@/lib/utils';
import { useExperiments, type ExperimentDto } from '@/hooks/use-research';
import { ExperimentDialog } from './experiment-dialog';

const STATUS_LABEL: Record<ExperimentDto['status'], string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  completed: 'Completed',
  aborted: 'Aborted',
  archived: 'Archived',
};

const OUTCOME_TONE: Record<ExperimentDto['outcome'], string> = {
  pending: 'outline',
  positive: 'default',
  negative: 'secondary',
  inconclusive: 'secondary',
  failed: 'destructive',
};

/**
 * Experiments in a project.
 *
 * Deliberately a list and a short form, not a laboratory notebook. An experiment here
 * exists so a file can point at it and a reader can find everything that came out of the
 * same run — the bench record itself stays in the protocols and raw data the experiment
 * links to.
 */
export function ExperimentList({ projectId }: { projectId: string }) {
  const [query, setQuery] = React.useState('');
  const [editing, setEditing] = React.useState<ExperimentDto | null>(null);
  const [creating, setCreating] = React.useState(false);
  const experiments = useExperiments({ projectId });

  const filtered = React.useMemo(() => {
    const items = experiments.data ?? [];
    const term = query.trim().toLowerCase();
    if (!term) return items;
    return items.filter(
      (experiment) =>
        experiment.code.toLowerCase().includes(term) ||
        experiment.title.toLowerCase().includes(term) ||
        experiment.sampleIds.some((sample) => sample.toLowerCase().includes(term)),
    );
  }, [experiments.data, query]);

  const canCreate = (experiments.data ?? []).some((experiment) => experiment.capabilities.edit);
  // With no experiments yet there is nothing to read a capability from, so the button is
  // offered and the server decides. A refusal is a clear message, not a silent dead end.
  const showCreate = canCreate || (experiments.data?.length ?? 0) === 0;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="size-4" aria-hidden="true" />
            Experiments
          </CardTitle>
          <CardDescription>
            What produced the data in this project. Files link to an experiment, and searching a
            sample ID finds every file recorded against it.
          </CardDescription>
        </div>
        {showCreate ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-2 size-3.5" aria-hidden="true" />
            New experiment
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-3">
        {(experiments.data?.length ?? 0) > 5 ? (
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by code, title or sample ID"
              className="h-9 pl-8"
              aria-label="Filter experiments"
            />
          </div>
        ) : null}

        {experiments.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            {query
              ? 'No experiment matches that.'
              : 'No experiments recorded yet. Add one so files can be traced back to the run that produced them.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((experiment) => (
              <li key={experiment.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{experiment.code}</span>
                  <span className="min-w-0 truncate text-sm">{experiment.title}</span>
                  <Badge variant="outline" className="ml-auto">
                    {STATUS_LABEL[experiment.status]}
                  </Badge>
                  <Badge
                    variant={
                      OUTCOME_TONE[experiment.outcome] as
                        | 'default'
                        | 'secondary'
                        | 'destructive'
                        | 'outline'
                    }
                  >
                    {experiment.outcome}
                  </Badge>
                </div>

                <p className="mt-1 text-xs text-muted-foreground">
                  {experiment.fileCount} file{experiment.fileCount === 1 ? '' : 's'}
                  {experiment.instrumentRef ? ` · ${experiment.instrumentRef}` : ''}
                  {experiment.organism ? ` · ${experiment.organism}` : ''}
                  {experiment.startedOn
                    ? ` · started ${formatRelativeTime(experiment.startedOn)}`
                    : ''}
                </p>

                {experiment.sampleIds.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {experiment.sampleIds.slice(0, 8).map((sample) => (
                      <Link key={sample} href={`/search?sampleId=${encodeURIComponent(sample)}`}>
                        <Badge variant="secondary" className="text-[10px] hover:bg-secondary/70">
                          {sample}
                        </Badge>
                      </Link>
                    ))}
                    {experiment.sampleIds.length > 8 ? (
                      <Badge variant="outline" className="text-[10px]">
                        +{experiment.sampleIds.length - 8} more
                      </Badge>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-2 flex gap-2">
                  <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
                    <Link href={`/search?experimentId=${experiment.id}`}>Show its files</Link>
                  </Button>
                  {experiment.capabilities.edit ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setEditing(experiment)}
                    >
                      Edit
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <ExperimentDialog
        projectId={projectId}
        experiment={editing}
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      />
    </Card>
  );
}
