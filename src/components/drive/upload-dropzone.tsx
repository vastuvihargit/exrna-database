'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Drop target for the folder currently open.
 *
 * The counter guards against the flicker every naive dropzone has: `dragleave` fires when
 * the pointer crosses into a *child* element, so tracking a boolean makes the overlay
 * blink. Counting enter/leave pairs does not.
 *
 * Folder drops are expanded through the `webkitGetAsEntry` tree so dragging a directory
 * uploads its contents rather than silently doing nothing.
 */
export function UploadDropzone({
  disabled,
  onFiles,
  children,
  className,
}: {
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    if (disabled) setDragging(false);
  }, [disabled]);

  const carriesFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes('Files');

  const onDragEnter = useCallback(
    (event: React.DragEvent) => {
      if (disabled || !carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    [disabled],
  );

  const onDragOver = useCallback(
    (event: React.DragEvent) => {
      if (disabled || !carriesFiles(event)) return;
      // Required, or the browser navigates to the dropped file instead of giving it to us.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    [disabled],
  );

  const onDragLeave = useCallback((event: React.DragEvent) => {
    if (!carriesFiles(event)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      if (disabled || !carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);

      const files = await collectFiles(event.dataTransfer);
      if (files.length > 0) onFiles(files);
    },
    [disabled, onFiles],
  );

  return (
    <div
      className={cn('relative', className)}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
    >
      {children}

      {dragging ? (
        <div
          className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-background/90 backdrop-blur-sm"
          aria-hidden="true"
        >
          <UploadCloud className="size-10 text-primary" />
          <p className="font-medium">Drop to upload here</p>
          <p className="text-sm text-muted-foreground">Folders are uploaded with their contents</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Flattens a drop into a file list, walking directory entries where the browser exposes
 * them. Falls back to `dataTransfer.files` when it does not.
 */
async function collectFiles(transfer: DataTransfer): Promise<File[]> {
  const items = Array.from(transfer.items ?? []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length === 0) return Array.from(transfer.files ?? []);

  const collected: File[] = [];
  await Promise.all(entries.map((entry) => walk(entry, collected)));
  return collected;
}

async function walk(entry: FileSystemEntry, into: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
    });
    // Ignore the noise a Finder/Explorer drag brings along.
    if (file && file.name !== '.DS_Store' && file.name !== 'Thumbs.db') into.push(file);
    return;
  }

  if (!entry.isDirectory) return;

  const reader = (entry as FileSystemDirectoryEntry).createReader();

  // readEntries returns at most ~100 per call and signals the end with an empty batch.
  const readBatch = () =>
    new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });

  for (;;) {
    const batch = await readBatch();
    if (batch.length === 0) break;
    await Promise.all(batch.map((child) => walk(child, into)));
  }
}
