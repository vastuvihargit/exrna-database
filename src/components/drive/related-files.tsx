'use client';

import * as React from 'react';
import Link from 'next/link';
import { Copy, FlaskConical, TestTube } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import { useRelatedFiles, type RelationReason } from '@/hooks/use-research';
import type { FileDto } from '@/hooks/use-files';
import { FileIcon } from './file-icon';

const REASON_LABEL: Record<RelationReason, string> = {
  duplicate: 'Same content',
  experiment: 'Same experiment',
  sample: 'Same sample',
  experiment_code: 'Same experiment code',
};

/**
 * Related files, loaded on demand.
 *
 * The panel opens collapsed: this is an extra query for every file anyone looks at, and
 * for most files the honest answer is "nothing related". Asking for it is a decision the
 * reader makes, not a cost every open pays.
 */
export function RelatedFiles({ file }: { file: FileDto }) {
  const [open, setOpen] = React.useState(false);
  const related = useRelatedFiles(file.id, open);

  const duplicates = (related.data ?? []).filter((entry) => entry.reasons.includes('duplicate'));

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Related files</h3>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Find related'}
        </Button>
      </div>

      {!open ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Other copies of these bytes, and files from the same experiment or sample.
        </p>
      ) : related.isLoading ? (
        <p className="mt-2 text-xs text-muted-foreground">Looking…</p>
      ) : related.error ? (
        <p className="mt-2 text-xs text-destructive">Could not load related files.</p>
      ) : (related.data?.length ?? 0) === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Nothing else in the drives you can open shares this file&rsquo;s content, experiment or
          sample.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {duplicates.length > 0 ? (
            <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
              <Copy className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {duplicates.length === 1
                ? 'One other file has exactly these bytes.'
                : `${duplicates.length} other files have exactly these bytes.`}{' '}
              Same content, filed separately.
            </p>
          ) : null}

          <ul className="space-y-2">
            {related.data?.map((entry) => (
              <li key={entry.file.id} className="rounded-md border p-2.5 text-xs">
                <Link
                  href={`/drive/${entry.file.folderId}`}
                  className="flex min-w-0 items-center gap-2 font-medium hover:underline"
                >
                  <FileIcon category={entry.file.category} className="size-3.5 shrink-0" />
                  <span className="truncate">{entry.file.displayName}</span>
                </Link>
                <p className="mt-1 text-muted-foreground">
                  {formatBytes(entry.file.sizeBytes)} · {formatRelativeTime(entry.file.updatedAt)}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {entry.reasons.map((reason) => (
                    <Badge
                      key={reason}
                      variant={reason === 'duplicate' ? 'destructive' : 'secondary'}
                      className="gap-1 text-[10px]"
                    >
                      {reason === 'duplicate' ? (
                        <Copy className="size-2.5" aria-hidden="true" />
                      ) : reason === 'sample' ? (
                        <TestTube className="size-2.5" aria-hidden="true" />
                      ) : (
                        <FlaskConical className="size-2.5" aria-hidden="true" />
                      )}
                      {REASON_LABEL[reason]}
                    </Badge>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
