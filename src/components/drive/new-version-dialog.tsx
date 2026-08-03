'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatBytes } from '@/lib/utils';
import type { FileDto } from '@/hooks/use-files';

export interface PendingVersion {
  /** The file that gains a version. */
  file: FileDto;
  /** The bytes the user just picked. */
  selected: File;
}

/**
 * Asks what changed before a new version is stored.
 *
 * Version notes were readable in the details panel and in every version list, and there
 * was nowhere to write one — so the field was permanently empty and the history read as
 * an anonymous stack of numbered files. The note is what makes "restore v3" a decision
 * rather than a guess, which is the whole reason this system keeps versions at all.
 *
 * It is not mandatory. Blocking an upload on a text box would just teach people to type
 * a full stop, and a wrong note is worse than no note.
 */
export function NewVersionDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingVersion | null;
  onCancel: () => void;
  /** Hands the note to the uploader; the tray reports progress from there. */
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = React.useState('');

  // A fresh note per pick — carrying the previous one over would silently mislabel a
  // version with the reason for the last one.
  React.useEffect(() => {
    setNote('');
  }, [pending?.selected]);

  const nextVersion = (pending?.file.versionCount ?? 0) + 1;
  const renamed =
    pending !== null && pending.selected.name !== pending.file.displayName;

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        {pending ? (
          <>
            <DialogHeader>
              <DialogTitle className="truncate">
                New version of &ldquo;{pending.file.displayName}&rdquo;
              </DialogTitle>
              <DialogDescription>
                This becomes version {nextVersion}. Version {pending.file.versionCount} stays
                downloadable — nothing is overwritten and nothing is lost.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="rounded-md border p-3 text-sm">
                <p className="truncate font-medium">{pending.selected.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(pending.selected.size)}
                </p>
              </div>

              {renamed ? (
                <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  The file you picked has a different name. It will still be stored as a new
                  version of &ldquo;{pending.file.displayName}&rdquo;, not as a separate file —
                  cancel if you meant to upload it on its own.
                </p>
              ) : null}

              <div className="space-y-1.5">
                <Label htmlFor="version-note">What changed?</Label>
                <textarea
                  id="version-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={3}
                  maxLength={500}
                  autoFocus
                  placeholder="e.g. Re-ran with the corrected calibration curve"
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <p className="text-[11px] text-muted-foreground">
                  Optional, and shown beside this version for ever. One line now saves someone
                  opening three versions to work out which is which.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button onClick={() => onConfirm(note.trim())}>
                Upload version {nextVersion}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
