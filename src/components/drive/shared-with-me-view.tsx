'use client';

import * as React from 'react';
import Link from 'next/link';
import { FolderClosed, Share2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api-client';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import type { FileDto } from '@/hooks/use-files';
import { useSharedWithMe } from '@/hooks/use-sharing';
import { FileDetailsPanel } from './file-details-panel';
import { FileIcon } from './file-icon';

export function SharedWithMeView() {
  const shared = useSharedWithMe();
  const [selected, setSelected] = React.useState<FileDto | null>(null);

  const files = shared.data?.files ?? [];
  const folders = shared.data?.folders ?? [];
  const isEmpty = !shared.isLoading && files.length === 0 && folders.length === 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Shared with me</h1>
        <p className="mt-1 text-muted-foreground">
          Items a colleague handed to you specifically. Content you can already reach through your
          department or a project is in those drives, not here.
        </p>
      </header>

      {shared.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      ) : shared.error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          {shared.error instanceof ApiError
            ? shared.error.message
            : 'Could not load what has been shared with you.'}
        </p>
      ) : isEmpty ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed py-16 text-center">
          <Share2 className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">Nothing shared with you yet</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            When someone shares a file or folder with you by name, it appears here.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {folders.length > 0 ? (
            <section aria-labelledby="shared-folders">
              <h2 id="shared-folders" className="mb-2 text-sm font-medium text-muted-foreground">
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
                        {formatRelativeTime(folder.updatedAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {files.length > 0 ? (
            <section aria-labelledby="shared-files">
              <h2 id="shared-files" className="mb-2 text-sm font-medium text-muted-foreground">
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
                        </span>
                      </span>
                      {file.approvalStatus === 'approved' ? (
                        <Badge className="hidden shrink-0 bg-emerald-600 hover:bg-emerald-600 sm:inline-flex">
                          Approved
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      <FileDetailsPanel file={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}
