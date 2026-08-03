'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bookmark, BookmarkCheck, FolderClosed, SearchX, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api-client';
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils';
import { FileIcon } from '@/components/drive/file-icon';
import { FileDetailsPanel } from '@/components/drive/file-details-panel';
import type { FileDto } from '@/hooks/use-files';
import {
  useDeleteSavedSearch,
  useSaveSearch,
  useSavedSearches,
  useSearch,
  useSearchFacets,
  type SearchCriteria,
} from '@/hooks/use-search';
import { useExperiments } from '@/hooks/use-research';

/** Filters offered in the panel. Every key here is one the search schema accepts. */
const CATEGORY_OPTIONS = [
  'document',
  'spreadsheet',
  'presentation',
  'image',
  'raw_data',
  'sequence',
  'chromatography',
  'archive',
  'code',
  'video',
  'audio',
  'other',
];

const CONFIDENTIALITY_OPTIONS = ['public_internal', 'internal', 'confidential', 'restricted'];
const REVIEW_OPTIONS = ['draft', 'submitted', 'in_review', 'changes_requested', 'approved', 'rejected'];
const APPROVAL_OPTIONS = ['none', 'pending', 'approved', 'rejected'];

const LABELS: Record<string, string> = {
  public_internal: 'Public (internal)',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
  raw_data: 'Raw data',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  none: 'Not submitted',
  experimentId: 'Experiment',
  experimentCode: 'Experiment code',
  sampleId: 'Sample ID',
};

function label(value: string): string {
  return LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');
}

/** Keys the filter panel manages, in the order the chips should read. */
const FILTER_KEYS = [
  'category',
  'confidentiality',
  'reviewStatus',
  'approvalStatus',
  'extension',
  'tags',
  'sampleId',
  'experimentId',
  'experimentCode',
  'study',
  'protocol',
  'instrument',
  'organism',
  'batchLot',
  'researcher',
  'updatedFrom',
  'updatedTo',
] as const;

export function SearchView() {
  const router = useRouter();
  const params = useSearchParams();

  // The URL is the single source of truth for the query, so a search is shareable,
  // bookmarkable and survives a refresh — and "save this search" is just saving the URL.
  const criteria = React.useMemo<SearchCriteria>(() => {
    const next: SearchCriteria = {};
    params.forEach((value, key) => {
      if (value) next[key] = value;
    });
    return next;
  }, [params]);

  const [showFilters, setShowFilters] = React.useState(false);
  const [selected, setSelected] = React.useState<FileDto | null>(null);

  const results = useSearch(criteria);
  const facets = useSearchFacets();
  const saved = useSavedSearches();
  const saveSearch = useSaveSearch();
  const deleteSaved = useDeleteSavedSearch();

  const apply = React.useCallback(
    (changes: SearchCriteria) => {
      const next = new URLSearchParams();
      for (const [key, value] of Object.entries({ ...criteria, ...changes })) {
        if (value) next.set(key, value);
      }
      next.delete('page');
      router.push(`/search?${next.toString()}`);
    },
    [criteria, router],
  );

  const clearFilter = (key: string) => apply({ [key]: '' });

  const activeFilters = FILTER_KEYS.filter((key) => criteria[key]);

  // Only fetched while an experiment filter is active — an experiment list on every
  // search would be a query nobody asked for.
  const experiments = useExperiments({ enabled: Boolean(criteria.experimentId) });
  const experimentLabel = criteria.experimentId
    ? (experiments.data?.find((entry) => entry.id === criteria.experimentId)?.code ??
      criteria.experimentId)
    : '';
  const term = criteria.q ?? '';
  const hasQuery = Object.keys(criteria).length > 0;

  const files = results.data?.files ?? [];
  const folders = results.data?.folders ?? [];
  const nothingFound =
    results.isSuccess && !results.data?.empty && files.length === 0 && folders.length === 0;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {term ? <>Results for “{term}”</> : 'Search'}
        </h1>
        <p className="text-muted-foreground">
          Searches every drive you can open — and only those. Files you have no access to never
          appear, and are not counted.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowFilters((open) => !open)}
          aria-expanded={showFilters}
        >
          <SlidersHorizontal className="mr-2 size-4" aria-hidden="true" />
          Filters
          {activeFilters.length > 0 ? (
            <Badge variant="secondary" className="ml-2">
              {activeFilters.length}
            </Badge>
          ) : null}
        </Button>

        {hasQuery ? (
          <SaveSearchButton
            criteria={criteria}
            isSaving={saveSearch.isPending}
            onSave={async (name) => {
              try {
                await saveSearch.mutateAsync({ name, criteria });
                toast.success(`Saved as “${name}”`);
              } catch (error) {
                toast.error(
                  error instanceof ApiError ? error.message : 'Could not save that search',
                );
              }
            }}
          />
        ) : null}

        {activeFilters.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => router.push(term ? `/search?q=${encodeURIComponent(term)}` : '/search')}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {activeFilters.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {activeFilters.map((key) => (
            <Badge key={key} variant="secondary" className="gap-1 pr-1">
              <span className="text-muted-foreground">{label(key)}:</span>{' '}
              {/* An experiment filter carries an id in the URL; showing the raw id would
                  be unreadable, so it is resolved to the code the researcher knows. */}
              {key === 'experimentId' ? experimentLabel : criteria[key]}
              <Button
                variant="ghost"
                size="icon"
                className="size-4"
                onClick={() => clearFilter(key)}
                aria-label={`Remove the ${label(key)} filter`}
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </Badge>
          ))}
        </div>
      ) : null}

      {showFilters ? (
        <FilterPanel
          criteria={criteria}
          onApply={apply}
          tagSuggestions={facets.data?.tags ?? []}
        />
      ) : null}

      {saved.data && saved.data.length > 0 ? (
        <section aria-labelledby="saved-searches">
          <h2 id="saved-searches" className="mb-2 text-sm font-medium">
            Saved searches
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {saved.data.map((entry) => (
              <span key={entry.id} className="inline-flex items-center rounded-md border text-sm">
                <Link
                  href={`/search?${new URLSearchParams(entry.criteria).toString()}`}
                  className="px-2.5 py-1 hover:underline"
                >
                  <BookmarkCheck className="mr-1.5 inline size-3.5" aria-hidden="true" />
                  {entry.name}
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 rounded-l-none"
                  aria-label={`Delete saved search "${entry.name}"`}
                  onClick={async () => {
                    await deleteSaved.mutateAsync(entry.id);
                    toast.success(`Deleted “${entry.name}”`);
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </Button>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <Separator />

      {results.data?.empty ? (
        <EmptyState
          title="Start with a term or a filter"
          description="Search a filename, a sample ID, an experiment code or a tag — or open Filters to browse by project, instrument or review status."
        />
      ) : results.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      ) : results.error ? (
        <EmptyState
          title="Search failed"
          description={
            results.error instanceof ApiError
              ? results.error.message
              : 'Something went wrong running that search.'
          }
        />
      ) : nothingFound ? (
        <EmptyState
          title="No matches"
          description="Nothing you can access matches that. Try a broader term, or remove a filter."
        />
      ) : (
        <div className="space-y-6">
          {folders.length > 0 ? (
            <section aria-labelledby="folder-results">
              <h2 id="folder-results" className="mb-2 text-sm font-medium text-muted-foreground">
                Folders
              </h2>
              <ul className="space-y-1">
                {folders.map((folder) => (
                  <li key={folder.id}>
                    <Link
                      href={`/drive/${folder.id}`}
                      className="flex items-center gap-3 rounded-md border p-3 hover:bg-accent"
                    >
                      <FolderClosed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {folder.fileCount} files
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {files.length > 0 ? (
            <section aria-labelledby="file-results">
              <h2 id="file-results" className="mb-2 text-sm font-medium text-muted-foreground">
                Files
              </h2>
              <ul className="space-y-1">
                {files.map((file) => (
                  <li key={file.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(file)}
                      className="flex w-full items-center gap-3 rounded-md border p-3 text-left hover:bg-accent"
                    >
                      <FileIcon category={file.category} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{file.displayName}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {formatBytes(file.sizeBytes)} · modified {formatRelativeTime(file.updatedAt)}
                          {typeof file.metadata.sampleId === 'string'
                            ? ` · sample ${file.metadata.sampleId}`
                            : ''}
                          {typeof file.metadata.experimentCode === 'string'
                            ? ` · ${file.metadata.experimentCode}`
                            : ''}
                        </span>
                      </span>
                      <span className="hidden shrink-0 gap-1.5 sm:flex">
                        {file.approvalStatus === 'approved' ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600">Approved</Badge>
                        ) : null}
                        {file.confidentiality === 'restricted' ? (
                          <Badge variant="destructive">Restricted</Badge>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <Link
            href={files[0] ? `/drive/${files[0].folderId}` : '/home'}
            className="sr-only"
            aria-hidden="true"
            tabIndex={-1}
          >
            Open containing folder
          </Link>
        </div>
      )}

      <FileDetailsPanel file={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}

function FilterPanel({
  criteria,
  onApply,
  tagSuggestions,
}: {
  criteria: SearchCriteria;
  onApply: (changes: SearchCriteria) => void;
  tagSuggestions: Array<{ value: string; count: number }>;
}) {
  return (
    <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-3">
      <FilterSelect
        id="category"
        label="Category"
        value={criteria.category ?? ''}
        options={CATEGORY_OPTIONS}
        onChange={(value) => onApply({ category: value })}
      />
      <FilterSelect
        id="confidentiality"
        label="Confidentiality"
        value={criteria.confidentiality ?? ''}
        options={CONFIDENTIALITY_OPTIONS}
        onChange={(value) => onApply({ confidentiality: value })}
      />
      <FilterSelect
        id="reviewStatus"
        label="Review status"
        value={criteria.reviewStatus ?? ''}
        options={REVIEW_OPTIONS}
        onChange={(value) => onApply({ reviewStatus: value })}
      />
      <FilterSelect
        id="approvalStatus"
        label="Approval"
        value={criteria.approvalStatus ?? ''}
        options={APPROVAL_OPTIONS}
        onChange={(value) => onApply({ approvalStatus: value })}
      />

      <FilterText
        id="sampleId"
        label="Sample ID"
        defaultValue={criteria.sampleId ?? ''}
        onCommit={(value) => onApply({ sampleId: value })}
      />
      <FilterText
        id="experimentCode"
        label="Experiment code"
        defaultValue={criteria.experimentCode ?? ''}
        onCommit={(value) => onApply({ experimentCode: value })}
      />
      <FilterText
        id="study"
        label="Study"
        defaultValue={criteria.study ?? ''}
        onCommit={(value) => onApply({ study: value })}
      />
      <FilterText
        id="instrument"
        label="Instrument"
        defaultValue={criteria.instrument ?? ''}
        onCommit={(value) => onApply({ instrument: value })}
      />
      <FilterText
        id="organism"
        label="Organism / material"
        defaultValue={criteria.organism ?? ''}
        onCommit={(value) => onApply({ organism: value })}
      />
      <FilterText
        id="extension"
        label="File extension"
        placeholder="fastq"
        defaultValue={criteria.extension ?? ''}
        onCommit={(value) => onApply({ extension: value.replace(/^\./, '').toLowerCase() })}
      />
      <FilterText
        id="updatedFrom"
        label="Modified from"
        type="date"
        defaultValue={criteria.updatedFrom ?? ''}
        onCommit={(value) => onApply({ updatedFrom: value })}
      />
      <FilterText
        id="updatedTo"
        label="Modified to"
        type="date"
        defaultValue={criteria.updatedTo ?? ''}
        onCommit={(value) => onApply({ updatedTo: value })}
      />

      {tagSuggestions.length > 0 ? (
        <div className="sm:col-span-2 lg:col-span-3">
          <p className="mb-1.5 text-sm font-medium">Tags in your files</p>
          <div className="flex flex-wrap gap-1.5">
            {tagSuggestions.slice(0, 20).map((tag) => {
              const current = (criteria.tags ?? '').split(',').filter(Boolean);
              const active = current.includes(tag.value);
              return (
                <button
                  key={tag.value}
                  type="button"
                  onClick={() =>
                    onApply({
                      tags: (active
                        ? current.filter((entry) => entry !== tag.value)
                        : [...current, tag.value]
                      ).join(','),
                    })
                  }
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                    active ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
                  )}
                  aria-pressed={active}
                >
                  {tag.value}
                  <span className="ml-1 opacity-60">{tag.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FilterSelect({
  id,
  label: labelText,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  // The Radix select cannot hold an empty-string item, so "Any" carries a sentinel that
  // is translated back to "no filter" here rather than leaking into the URL.
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{labelText}</Label>
      <Select value={value || '__any__'} onValueChange={(next) => onChange(next === '__any__' ? '' : next)}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Any" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__any__">Any</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {label(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function FilterText({
  id,
  label: labelText,
  defaultValue,
  placeholder,
  type = 'text',
  onCommit,
}: {
  id: string;
  label: string;
  defaultValue: string;
  placeholder?: string;
  type?: string;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = React.useState(defaultValue);
  React.useEffect(() => setValue(defaultValue), [defaultValue]);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{labelText}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        // Commit on blur or Enter, never per keystroke: each commit is a navigation and
        // a fresh query.
        onBlur={() => value !== defaultValue && onCommit(value.trim())}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommit(value.trim());
          }
        }}
      />
    </div>
  );
}

function SaveSearchButton({
  criteria,
  isSaving,
  onSave,
}: {
  criteria: SearchCriteria;
  isSaving: boolean;
  onSave: (name: string) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');

  React.useEffect(() => {
    if (open) setName(criteria.q ?? 'Saved search');
  }, [open, criteria.q]);

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Bookmark className="mr-2 size-4" aria-hidden="true" />
        Save this search
      </Button>
    );
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim()) return;
        await onSave(name.trim());
        setOpen(false);
      }}
    >
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="h-9 w-48"
        aria-label="Name for this saved search"
        autoFocus
      />
      <Button type="submit" size="sm" disabled={isSaving || !name.trim()}>
        Save
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed py-16 text-center">
      <SearchX className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
