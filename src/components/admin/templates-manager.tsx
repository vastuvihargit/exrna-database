'use client';

import * as React from 'react';
import { GripVertical, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api-client';
import {
  useFolderTemplates,
  useMetadataTemplates,
  useSaveFolderTemplates,
  useSaveMetadataTemplates,
} from '@/hooks/use-research';

interface FolderRow {
  key?: string;
  name: string;
  description: string;
}

/**
 * Folder and metadata template administration.
 *
 * Two things this page deliberately does not do:
 *
 *  • It does not rewrite existing drives. A renamed template folder would otherwise
 *    rename it in every live project, where people have linked to and cited its
 *    contents. The project dashboard reports which template folders a drive is missing
 *    instead, so the difference is visible and someone decides.
 *
 *  • It does not let anyone invent a metadata field. The picker offers exactly the
 *    fields the server declares, because a template's field keys become dotted paths
 *    under `File.metadata` — a free-text key here would reach straight past the
 *    allow-list that exists to stop that.
 */
export function TemplatesManager() {
  return (
    <div className="space-y-6">
      <FolderTemplateEditor />
      <MetadataTemplateEditor />
    </div>
  );
}

function FolderTemplateEditor() {
  const templates = useFolderTemplates();
  const save = useSaveFolderTemplates();
  const [rows, setRows] = React.useState<FolderRow[] | null>(null);

  React.useEffect(() => {
    if (templates.data && rows === null) {
      setRows(templates.data.project.map((entry) => ({ ...entry })));
    }
  }, [templates.data, rows]);

  if (templates.isLoading || rows === null) {
    return <Skeleton className="h-64 w-full" />;
  }

  const move = (index: number, delta: number) => {
    const next = [...rows];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    setRows(next);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">Project folder template</CardTitle>
          <CardDescription>
            The folders every new project drive starts with. Identical structure everywhere is what
            makes &ldquo;where is the protocol?&rdquo; answerable without asking anyone.
          </CardDescription>
        </div>
        {templates.data?.customized ? <Badge variant="secondary">Customized</Badge> : null}
      </CardHeader>

      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {rows.map((row, index) => (
            <li key={index} className="flex items-start gap-2 rounded-md border p-2">
              <div className="flex flex-col pt-1.5">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move ${row.name} up`}
                >
                  <GripVertical className="size-3.5 rotate-90" aria-hidden="true" />
                </button>
              </div>

              <div className="grid flex-1 gap-2 sm:grid-cols-2">
                <Input
                  value={row.name}
                  onChange={(event) =>
                    setRows(rows.map((entry, i) => (i === index ? { ...entry, name: event.target.value } : entry)))
                  }
                  maxLength={200}
                  aria-label={`Folder ${index + 1} name`}
                  className="h-8 text-sm"
                />
                <Input
                  value={row.description}
                  onChange={(event) =>
                    setRows(
                      rows.map((entry, i) =>
                        i === index ? { ...entry, description: event.target.value } : entry,
                      ),
                    )
                  }
                  maxLength={300}
                  placeholder="What belongs here"
                  aria-label={`Folder ${index + 1} description`}
                  className="h-8 text-sm"
                />
              </div>

              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-destructive"
                onClick={() => setRows(rows.filter((_, i) => i !== index))}
                aria-label={`Remove ${row.name}`}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRows([...rows, { name: '', description: '' }])}
          >
            <Plus className="mr-2 size-3.5" aria-hidden="true" />
            Add folder
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRows(templates.data?.project.map((entry) => ({ ...entry })) ?? [])}
          >
            <RotateCcw className="mr-2 size-3.5" aria-hidden="true" />
            Discard changes
          </Button>
          <Button
            size="sm"
            className="ml-auto"
            disabled={save.isPending || rows.some((row) => !row.name.trim())}
            onClick={async () => {
              try {
                const result = await save.mutateAsync({
                  project: rows.map((row) => ({
                    ...(row.key ? { key: row.key } : {}),
                    name: row.name.trim(),
                    description: row.description.trim(),
                  })),
                });
                setRows(result.project.map((entry) => ({ ...entry })));
                toast.success('Folder template saved', {
                  description: 'Existing drives are unchanged — this applies to new project drives.',
                });
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : 'Could not save the template');
              }
            }}
          >
            {save.isPending ? 'Saving…' : 'Save template'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function MetadataTemplateEditor() {
  const templates = useMetadataTemplates();
  const save = useSaveMetadataTemplates();
  const [drafts, setDrafts] = React.useState<
    Array<{ key: string; label: string; description: string; fieldKeys: string[] }> | null
  >(null);

  React.useEffect(() => {
    if (templates.data && drafts === null) {
      setDrafts(
        templates.data.templates.map((template) => ({
          key: template.key,
          label: template.label,
          description: template.description,
          fieldKeys: [...template.fieldKeys],
        })),
      );
    }
  }, [templates.data, drafts]);

  if (templates.isLoading || drafts === null) {
    return <Skeleton className="h-64 w-full" />;
  }

  const fields = templates.data?.fields ?? [];

  const toggleField = (index: number, fieldKey: string) => {
    setDrafts(
      drafts.map((draft, i) =>
        i === index
          ? {
              ...draft,
              fieldKeys: draft.fieldKeys.includes(fieldKey)
                ? draft.fieldKeys.filter((key) => key !== fieldKey)
                : [...draft.fieldKeys, fieldKey],
            }
          : draft,
      ),
    );
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">Metadata form templates</CardTitle>
          <CardDescription>
            Which research fields each upload form asks for. A template arranges the declared
            fields — it cannot add a new one, because a field also needs a type, a control and a
            search index.
          </CardDescription>
        </div>
        {templates.data?.customized ? <Badge variant="secondary">Customized</Badge> : null}
      </CardHeader>

      <CardContent className="space-y-4">
        {drafts.map((draft, index) => (
          <div key={draft.key} className="space-y-2 rounded-md border p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`template-label-${draft.key}`} className="text-xs">
                  Name
                </Label>
                <Input
                  id={`template-label-${draft.key}`}
                  value={draft.label}
                  onChange={(event) =>
                    setDrafts(
                      drafts.map((entry, i) =>
                        i === index ? { ...entry, label: event.target.value } : entry,
                      ),
                    )
                  }
                  maxLength={80}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`template-desc-${draft.key}`} className="text-xs">
                  Description
                </Label>
                <Input
                  id={`template-desc-${draft.key}`}
                  value={draft.description}
                  onChange={(event) =>
                    setDrafts(
                      drafts.map((entry, i) =>
                        i === index ? { ...entry, description: event.target.value } : entry,
                      ),
                    )
                  }
                  maxLength={300}
                  className="h-8 text-sm"
                />
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">
                Fields shown by this template ({draft.fieldKeys.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {fields.map((field) => {
                  const selected = draft.fieldKeys.includes(field.key);
                  return (
                    <button
                      key={field.key}
                      type="button"
                      onClick={() => toggleField(index, field.key)}
                      aria-pressed={selected}
                      className="rounded-full"
                    >
                      <Badge variant={selected ? 'default' : 'outline'} className="cursor-pointer">
                        {field.label}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ))}

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setDrafts(
                templates.data?.templates.map((template) => ({
                  key: template.key,
                  label: template.label,
                  description: template.description,
                  fieldKeys: [...template.fieldKeys],
                })) ?? [],
              )
            }
          >
            <RotateCcw className="mr-2 size-3.5" aria-hidden="true" />
            Discard changes
          </Button>
          <Button
            size="sm"
            disabled={save.isPending || drafts.some((draft) => draft.fieldKeys.length === 0)}
            onClick={async () => {
              try {
                await save.mutateAsync(drafts);
                toast.success('Metadata templates saved');
              } catch (error) {
                toast.error(
                  error instanceof ApiError ? error.message : 'Could not save the templates',
                );
              }
            }}
          >
            {save.isPending ? 'Saving…' : 'Save templates'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
