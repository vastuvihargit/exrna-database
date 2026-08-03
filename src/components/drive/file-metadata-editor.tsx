'use client';

import * as React from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { useUpdateFile, type FileDto } from '@/hooks/use-files';
import { useMetadataTemplates, type MetadataFieldDto } from '@/hooks/use-search';
import { useExperiments } from '@/hooks/use-research';

/**
 * The research-annotation form.
 *
 * The field list, its types and its options are fetched from the server rather than
 * hard-coded here. A second copy in the client would drift from the allow-list the
 * server validates against, and the drift would surface as a form offering an option
 * that is then rejected on save.
 *
 * A template chooses *which* fields to show; it never restricts what may be saved. A
 * file that already carries an annotation outside the chosen template still shows it,
 * because hiding recorded research data would be a worse failure than a slightly longer
 * form.
 */
export function FileMetadataEditor({ file }: { file: FileDto }) {
  const definitions = useMetadataTemplates();
  const update = useUpdateFile();

  const [templateKey, setTemplateKey] = React.useState<string>('');
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [tags, setTags] = React.useState<string[]>(file.tags);
  const [tagDraft, setTagDraft] = React.useState('');
  const [dirty, setDirty] = React.useState(false);

  // Re-seed whenever a different file is opened, or the saved values change under us.
  React.useEffect(() => {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(file.metadata ?? {})) {
      next[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    }
    setValues(next);
    setTags(file.tags);
    setDirty(false);
  }, [file.id, file.metadata, file.tags]);

  const templates = definitions.data?.templates ?? [];
  const fields = definitions.data?.fields ?? [];

  const activeTemplate =
    templates.find((template) => template.key === templateKey) ??
    templates.find((template) => template.key === (definitions.data?.suggested ?? 'general')) ??
    templates[0];

  const visibleKeys = React.useMemo(() => {
    const fromTemplate = activeTemplate?.fieldKeys ?? [];
    // Anything already annotated stays visible even if this template omits it.
    const alreadySet = Object.keys(values).filter((key) => values[key]);
    return [...new Set([...fromTemplate, ...alreadySet])];
  }, [activeTemplate, values]);

  const setValue = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  const canEdit = file.capabilities.canEditMetadata;

  const save = async () => {
    // An empty string means "clear this annotation"; the server turns it into an $unset.
    const metadata: Record<string, unknown> = {};
    for (const key of new Set([...visibleKeys, ...Object.keys(values)])) {
      const raw = values[key] ?? '';
      const definition = fields.find((entry) => entry.key === key);
      if (!definition) continue;

      if (!raw.trim()) {
        metadata[key] = null;
        continue;
      }
      metadata[key] =
        definition.type === 'list'
          ? raw.split(',').map((entry) => entry.trim()).filter(Boolean)
          : definition.type === 'number'
            ? Number(raw)
            : raw;
    }

    try {
      await update.mutateAsync({ fileId: file.id, metadata, tags });
      setDirty(false);
      toast.success('Research metadata saved');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not save the metadata');
    }
  };

  if (definitions.isLoading) {
    return <p className="text-xs text-muted-foreground">Loading the metadata form…</p>;
  }

  if (!canEdit) {
    const annotated = Object.entries(file.metadata ?? {}).filter(([, value]) => value !== null && value !== '');
    return annotated.length > 0 ? (
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        {annotated.map(([key, value]) => {
          const definition = fields.find((entry) => entry.key === key);
          return (
            <div key={key}>
              <dt className="text-muted-foreground">{definition?.label ?? key}</dt>
              <dd className="font-medium">{Array.isArray(value) ? value.join(', ') : String(value)}</dd>
            </div>
          );
        })}
      </dl>
    ) : (
      <p className="text-xs text-muted-foreground">
        No research metadata recorded, and you do not have permission to add any.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <ExperimentLink file={file} />

      <div className="space-y-1.5">
        <Label htmlFor="metadata-template" className="text-xs">
          Template
        </Label>
        <Select value={activeTemplate?.key ?? ''} onValueChange={setTemplateKey}>
          <SelectTrigger id="metadata-template" className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {templates.map((template) => (
              <SelectItem key={template.key} value={template.key}>
                {template.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {activeTemplate ? (
          <p className="text-[11px] text-muted-foreground">{activeTemplate.description}</p>
        ) : null}
      </div>

      {visibleKeys.map((key) => {
        const definition = fields.find((entry) => entry.key === key);
        if (!definition) return null;
        return (
          <MetadataInput
            key={key}
            definition={definition}
            value={values[key] ?? ''}
            recommended={activeTemplate?.recommendedKeys?.includes(key) ?? false}
            onChange={(value) => setValue(key, value)}
          />
        );
      })}

      <div className="space-y-1.5">
        <Label htmlFor="metadata-tags" className="text-xs">
          Tags
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <Badge key={tag} variant="outline" className="gap-1 pr-1">
              {tag}
              <Button
                variant="ghost"
                size="icon"
                className="size-4"
                aria-label={`Remove tag ${tag}`}
                onClick={() => {
                  setTags((current) => current.filter((entry) => entry !== tag));
                  setDirty(true);
                }}
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </Badge>
          ))}
        </div>
        <div className="flex gap-1.5">
          <Input
            id="metadata-tags"
            value={tagDraft}
            onChange={(event) => setTagDraft(event.target.value)}
            placeholder="Add a tag"
            className="h-8 text-xs"
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              addTag();
            }}
          />
          <Button variant="outline" size="icon" className="size-8" onClick={addTag} aria-label="Add tag">
            <Plus className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <Button size="sm" className="w-full" disabled={!dirty || update.isPending} onClick={save}>
        {update.isPending ? (
          <>
            <Loader2 className="mr-2 size-3.5 animate-spin" aria-hidden="true" />
            Saving…
          </>
        ) : (
          'Save metadata'
        )}
      </Button>
    </div>
  );

  function addTag() {
    const value = tagDraft.trim();
    if (!value) return;
    // Case-insensitive: "qPCR" and "qpcr" as separate tags would split every search
    // that used either. The server applies the same rule.
    if (tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      setTagDraft('');
      return;
    }
    setTags((current) => [...current, value]);
    setTagDraft('');
    setDirty(true);
  }
}

/**
 * Links the file to the experiment that produced it.
 *
 * Saved on change rather than with the rest of the form: this is the one annotation that
 * changes what the file *is* — it moves the file onto a project dashboard and into the
 * "same experiment" side of related files — and burying it in an unsaved form makes it
 * easy to lose. The server refuses experiments in projects the user has no part in, so
 * the list is only ever offering choices it will also accept.
 */
function ExperimentLink({ file }: { file: FileDto }) {
  const experiments = useExperiments(file.projectId ? { projectId: file.projectId } : {});
  const update = useUpdateFile();

  const options = experiments.data ?? [];
  const current = options.find((experiment) => experiment.id === file.experimentId);

  if (!file.capabilities.canEditMetadata) {
    return current ? (
      <div>
        <p className="text-xs text-muted-foreground">Experiment</p>
        <p className="text-xs font-medium">
          {current.code} — {current.title}
        </p>
      </div>
    ) : null;
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="metadata-experiment" className="text-xs">
        Experiment
      </Label>
      <Select
        value={file.experimentId ?? '__none__'}
        onValueChange={async (next) => {
          try {
            await update.mutateAsync({
              fileId: file.id,
              experimentId: next === '__none__' ? null : next,
            });
            toast.success(next === '__none__' ? 'Experiment link removed' : 'Linked to experiment');
          } catch (error) {
            toast.error(error instanceof ApiError ? error.message : 'Could not link the experiment');
          }
        }}
      >
        <SelectTrigger id="metadata-experiment" className="h-8 text-xs">
          <SelectValue placeholder="Not linked" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">Not linked</SelectItem>
          {options.map((experiment) => (
            <SelectItem key={experiment.id} value={experiment.id}>
              {experiment.code} — {experiment.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">
        {options.length === 0
          ? 'No experiments recorded in the projects you work on yet.'
          : 'Connects this file to the run that produced it.'}
      </p>
    </div>
  );
}

function MetadataInput({
  definition,
  value,
  recommended,
  onChange,
}: {
  definition: MetadataFieldDto;
  value: string;
  recommended: boolean;
  onChange: (value: string) => void;
}) {
  const id = `metadata-${definition.key}`;

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {definition.label}
        {recommended ? <span className="ml-1 text-muted-foreground">(recommended)</span> : null}
      </Label>

      {definition.type === 'select' ? (
        <Select
          value={value || '__none__'}
          onValueChange={(next) => onChange(next === '__none__' ? '' : next)}
        >
          <SelectTrigger id={id} className="h-8 text-xs">
            <SelectValue placeholder="Not set" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">Not set</SelectItem>
            {(definition.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>
                {option.charAt(0).toUpperCase() + option.slice(1).replace(/_/g, ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : definition.type === 'longtext' ? (
        <textarea
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={3}
          maxLength={definition.maxLength}
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      ) : (
        <Input
          id={id}
          type={definition.type === 'date' ? 'date' : definition.type === 'number' ? 'number' : 'text'}
          value={value}
          maxLength={definition.maxLength}
          min={definition.min}
          max={definition.max}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 text-xs"
        />
      )}

      {definition.hint ? (
        <p className="text-[11px] text-muted-foreground">{definition.hint}</p>
      ) : null}
    </div>
  );
}
