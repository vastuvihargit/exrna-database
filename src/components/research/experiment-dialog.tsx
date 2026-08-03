'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api-client';
import {
  useArchiveExperiment,
  useCreateExperiment,
  useUpdateExperiment,
  type ExperimentDto,
} from '@/hooks/use-research';

const STATUSES: Array<ExperimentDto['status']> = [
  'planned',
  'in_progress',
  'completed',
  'aborted',
];
const OUTCOMES: Array<ExperimentDto['outcome']> = [
  'pending',
  'positive',
  'negative',
  'inconclusive',
  'failed',
];

interface FormState {
  code: string;
  title: string;
  objective: string;
  status: ExperimentDto['status'];
  outcome: ExperimentDto['outcome'];
  outcomeSummary: string;
  protocolRef: string;
  instrumentRef: string;
  organism: string;
  sampleIds: string;
  startedOn: string;
  completedOn: string;
}

const EMPTY: FormState = {
  code: '',
  title: '',
  objective: '',
  status: 'planned',
  outcome: 'pending',
  outcomeSummary: '',
  protocolRef: '',
  instrumentRef: '',
  organism: '',
  sampleIds: '',
  startedOn: '',
  completedOn: '',
};

/**
 * Create or edit an experiment.
 *
 * The code is fixed once created. It is what gets written on tubes and quoted in
 * reports, and files already point at this record — renaming the identifier afterwards
 * would break exactly the traceability the record exists to provide.
 */
export function ExperimentDialog({
  projectId,
  experiment,
  open,
  onOpenChange,
}: {
  projectId: string;
  experiment: ExperimentDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = React.useState<FormState>(EMPTY);
  const create = useCreateExperiment();
  const update = useUpdateExperiment();
  const archive = useArchiveExperiment();

  React.useEffect(() => {
    if (!open) return;
    setForm(
      experiment
        ? {
            code: experiment.code,
            title: experiment.title,
            objective: experiment.objective,
            status: experiment.status === 'archived' ? 'completed' : experiment.status,
            outcome: experiment.outcome,
            outcomeSummary: experiment.outcomeSummary,
            protocolRef: experiment.protocolRef,
            instrumentRef: experiment.instrumentRef,
            organism: experiment.organism,
            sampleIds: experiment.sampleIds.join(', '),
            startedOn: experiment.startedOn?.slice(0, 10) ?? '',
            completedOn: experiment.completedOn?.slice(0, 10) ?? '',
          }
        : EMPTY,
    );
  }, [open, experiment]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const pending = create.isPending || update.isPending || archive.isPending;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    const payload = {
      title: form.title.trim(),
      objective: form.objective.trim(),
      status: form.status,
      outcome: form.outcome,
      outcomeSummary: form.outcomeSummary.trim(),
      protocolRef: form.protocolRef.trim(),
      instrumentRef: form.instrumentRef.trim(),
      organism: form.organism.trim(),
      sampleIds: form.sampleIds
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
      startedOn: form.startedOn || null,
      completedOn: form.completedOn || null,
    };

    try {
      if (experiment) {
        await update.mutateAsync({ experimentId: experiment.id, ...payload });
        toast.success(`${experiment.code} updated`);
      } else {
        const created = await create.mutateAsync({
          projectId,
          code: form.code.trim(),
          ...payload,
        });
        toast.success(`Experiment ${created.code} recorded`);
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not save the experiment');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{experiment ? `Edit ${experiment.code}` : 'New experiment'}</DialogTitle>
            <DialogDescription>
              An experiment is the anchor a file is traced back to. Only the code and a title are
              required — the rest can be filled in as the run progresses.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="experiment-code">Code</Label>
              <Input
                id="experiment-code"
                value={form.code}
                onChange={(event) => set('code', event.target.value)}
                placeholder="EXP-2026-014"
                maxLength={60}
                disabled={Boolean(experiment)}
                required
                autoFocus={!experiment}
              />
              {experiment ? (
                <p className="text-[11px] text-muted-foreground">
                  Codes cannot change — files already reference this one.
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="experiment-title">Title</Label>
              <Input
                id="experiment-title"
                value={form.title}
                onChange={(event) => set('title', event.target.value)}
                maxLength={200}
                required
              />
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="experiment-objective">Objective</Label>
              <textarea
                id="experiment-objective"
                value={form.objective}
                onChange={(event) => set('objective', event.target.value)}
                rows={2}
                maxLength={4000}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="experiment-status">Status</Label>
              <Select
                value={form.status}
                onValueChange={(value) => set('status', value as ExperimentDto['status'])}
              >
                <SelectTrigger id="experiment-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {status.replace('_', ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="experiment-outcome">Outcome</Label>
              <Select
                value={form.outcome}
                onValueChange={(value) => set('outcome', value as ExperimentDto['outcome'])}
              >
                <SelectTrigger id="experiment-outcome">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OUTCOMES.map((outcome) => (
                    <SelectItem key={outcome} value={outcome}>
                      {outcome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Field
              id="experiment-protocol"
              label="Protocol"
              value={form.protocolRef}
              onChange={(value) => set('protocolRef', value)}
              hint="The SOP or protocol this run followed"
            />
            <Field
              id="experiment-instrument"
              label="Instrument"
              value={form.instrumentRef}
              onChange={(value) => set('instrumentRef', value)}
            />
            <Field
              id="experiment-organism"
              label="Organism / material"
              value={form.organism}
              onChange={(value) => set('organism', value)}
            />

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="experiment-samples">Sample IDs</Label>
              <Input
                id="experiment-samples"
                value={form.sampleIds}
                onChange={(event) => set('sampleIds', event.target.value)}
                placeholder="S-1042, S-1043, S-1044"
              />
              <p className="text-[11px] text-muted-foreground">
                Comma separated. Each one becomes a search anyone can run.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="experiment-started">Started</Label>
              <Input
                id="experiment-started"
                type="date"
                value={form.startedOn}
                onChange={(event) => set('startedOn', event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="experiment-completed">Completed</Label>
              <Input
                id="experiment-completed"
                type="date"
                value={form.completedOn}
                onChange={(event) => set('completedOn', event.target.value)}
              />
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="experiment-summary">Result summary</Label>
              <textarea
                id="experiment-summary"
                value={form.outcomeSummary}
                onChange={(event) => set('outcomeSummary', event.target.value)}
                rows={2}
                maxLength={2000}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {experiment?.capabilities.delete ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={pending}
                onClick={async () => {
                  try {
                    await archive.mutateAsync(experiment.id);
                    toast.success(`${experiment.code} archived`, {
                      description:
                        'Files that referenced it keep the link — the record of what produced them stays.',
                    });
                    onOpenChange(false);
                  } catch (error) {
                    toast.error(
                      error instanceof ApiError ? error.message : 'Could not archive the experiment',
                    );
                  }
                }}
              >
                Archive
              </Button>
            ) : (
              <span />
            )}

            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={pending || !form.title.trim() || (!experiment && !form.code.trim())}
              >
                {pending ? 'Saving…' : experiment ? 'Save changes' : 'Create experiment'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  value,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} maxLength={200} />
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
