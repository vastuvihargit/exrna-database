'use client';

import * as React from 'react';
import { CheckCircle2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api-client';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import { FileDetailsPanel } from '@/components/drive/file-details-panel';
import { FileIcon } from '@/components/drive/file-icon';
import type { FileDto } from '@/hooks/use-files';
import { useApprovedFiles } from '@/hooks/use-reviews';

/**
 * Files whose current version carries a recorded approval.
 *
 * This is the direct answer to "which is the latest approved version?" — the question
 * the brief opens with. A file only appears here while its approval still applies:
 * uploading a new version clears the approval, and the file drops off this list rather
 * than showing a badge for bytes nobody signed.
 */
export function ApprovedFilesView() {
  const approved = useApprovedFiles();
  const [selected, setSelected] = React.useState<FileDto | null>(null);

  const files = approved.data?.files ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Approved files</h1>
        <p className="mt-1 text-muted-foreground">
          Signed off and read-only. Changing one of these means uploading a new version — the
          approved version stays available and keeps its approval record.
        </p>
      </header>

      {approved.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      ) : approved.error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          {approved.error instanceof ApiError
            ? approved.error.message
            : 'Could not load approved files.'}
        </p>
      ) : files.length === 0 ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed py-16 text-center">
          <CheckCircle2 className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">Nothing approved yet</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Files appear here once a reviewer has approved a specific version of them.
          </p>
        </div>
      ) : (
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
                    {formatBytes(file.sizeBytes)} · version {file.versionCount} · approved{' '}
                    {formatRelativeTime(file.updatedAt)}
                  </span>
                </span>
                <Badge className="hidden shrink-0 bg-emerald-600 hover:bg-emerald-600 sm:inline-flex">
                  Approved
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      )}

      <FileDetailsPanel file={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}
