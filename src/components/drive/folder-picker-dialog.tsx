'use client';

import { useState } from 'react';
import { ChevronRight, CornerLeftUp, FolderClosed, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useDrives, useFolder, useFolderChildren, type FolderDto } from '@/hooks/use-drive';

const BROWSE_QUERY = { page: 1, pageSize: 100, sort: 'name', order: 'asc' } as const;

/**
 * Destination picker for move and copy.
 *
 * The folder being moved and everything under it are disabled rather than hidden: a
 * user who cannot find the folder they are looking at assumes the app is broken, while
 * a greyed-out row with a reason is self-explanatory.
 */
export function FolderPickerDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  excludeSubtreeOf,
  initialFolderId,
  onConfirm,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  /** The folder being moved: it and its descendants cannot be the destination. */
  excludeSubtreeOf?: FolderDto | null;
  initialFolderId: string | null;
  onConfirm: (targetFolderId: string) => void;
  isPending?: boolean;
}) {
  const [currentId, setCurrentId] = useState<string | null>(initialFolderId);
  const drives = useDrives();
  const current = useFolder(currentId);
  const children = useFolderChildren(currentId, BROWSE_QUERY);

  const folder = current.data?.folder;
  const parentId = folder?.parentFolderId ?? null;

  const isForbidden = (candidate: FolderDto): string | null => {
    if (!excludeSubtreeOf) return null;
    if (candidate.id === excludeSubtreeOf.id) return 'This is the folder you are moving';
    if (candidate.pathAncestors.includes(excludeSubtreeOf.id)) return 'Inside the folder you are moving';
    return null;
  };

  const canConfirm =
    currentId !== null &&
    folder !== undefined &&
    folder.capabilities.canCreateFolder &&
    (!excludeSubtreeOf ||
      (folder.id !== excludeSubtreeOf.id && !folder.pathAncestors.includes(excludeSubtreeOf.id)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <FolderClosed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate font-medium">{folder?.name ?? 'Choose a drive'}</span>
          </div>

          <div className="h-64 overflow-y-auto rounded-md border">
            {currentId === null ? (
              <DriveList
                onSelect={setCurrentId}
                drives={drives.data}
                isLoading={drives.isLoading}
              />
            ) : (
              <ul className="divide-y">
                <li>
                  <button
                    type="button"
                    onClick={() => setCurrentId(parentId)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <CornerLeftUp className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span className="text-muted-foreground">
                      {parentId ? 'Up one level' : 'All drives'}
                    </span>
                  </button>
                </li>

                {children.isLoading ? (
                  <li className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Loading…
                  </li>
                ) : null}

                {children.data?.folders.map((child) => {
                  const forbidden = isForbidden(child);
                  return (
                    <li key={child.id}>
                      <button
                        type="button"
                        disabled={forbidden !== null}
                        onClick={() => setCurrentId(child.id)}
                        title={forbidden ?? undefined}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                          forbidden ? 'cursor-not-allowed opacity-50' : 'hover:bg-muted',
                        )}
                      >
                        <FolderClosed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="truncate">{child.name}</span>
                        {forbidden ? (
                          <span className="ml-auto text-xs text-muted-foreground">{forbidden}</span>
                        ) : (
                          <ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
                        )}
                      </button>
                    </li>
                  );
                })}

                {!children.isLoading && children.data?.folders.length === 0 ? (
                  <li className="px-3 py-3 text-sm text-muted-foreground">No subfolders here.</li>
                ) : null}
              </ul>
            )}
          </div>

          {folder && !folder.capabilities.canCreateFolder ? (
            <p className="text-xs text-destructive">
              You do not have permission to add items to this folder.
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canConfirm || isPending}
            onClick={() => currentId && onConfirm(currentId)}
          >
            {isPending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DriveList({
  drives,
  isLoading,
  onSelect,
}: {
  drives: ReturnType<typeof useDrives>['data'];
  isLoading: boolean;
  onSelect: (id: string) => void;
}) {
  if (isLoading) {
    return (
      <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading drives…
      </p>
    );
  }

  const entries = [
    ...(drives?.myDrive.rootFolderId
      ? [{ id: drives.myDrive.rootFolderId, name: 'My Drive' }]
      : []),
    ...(drives?.departments ?? [])
      .filter((drive) => drive.rootFolderId)
      .map((drive) => ({ id: drive.rootFolderId as string, name: drive.name })),
    ...(drives?.projects ?? [])
      .filter((drive) => drive.rootFolderId)
      .map((drive) => ({ id: drive.rootFolderId as string, name: `${drive.code} — ${drive.name}` })),
  ];

  if (entries.length === 0) {
    return (
      <p className="px-3 py-3 text-sm text-muted-foreground">
        Open a drive once before using it as a destination.
      </p>
    );
  }

  return (
    <ul className="divide-y">
      {entries.map((entry) => (
        <li key={entry.id}>
          <button
            type="button"
            onClick={() => onSelect(entry.id)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
          >
            <FolderClosed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{entry.name}</span>
            <ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
