'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Building2, FlaskConical, FolderClosed, HardDrive } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { BreadcrumbDto } from '@/hooks/use-drive';
import { DRIVE_DRAG_MIME } from './drive-intents';

/** Long paths collapse in the middle: the root and the last two levels are what orient a user. */
const VISIBLE_TAIL = 2;

function driveIcon(driveType: string) {
  if (driveType === 'department') return Building2;
  if (driveType === 'project') return FlaskConical;
  return HardDrive;
}

/**
 * The path, and — when the caller supplies the handlers — the way back up.
 *
 * A breadcrumb is the only visible ancestor while you are inside a folder, so dropping
 * onto one is how "move this out of here" is expressed in every file manager. Without it
 * dragging can only ever move things deeper.
 */
export function DriveBreadcrumbs({
  trail,
  className,
  onDropItems,
  canAcceptDrop,
}: {
  trail: BreadcrumbDto[];
  className?: string;
  onDropItems?: (folderId: string, event: React.DragEvent) => void;
  canAcceptDrop?: (folderId: string) => boolean;
}) {
  const [over, setOver] = useState<string | null>(null);

  if (trail.length === 0) return null;

  const root = trail[0]!;
  const RootIcon = driveIcon(root.driveType);
  const collapsed = trail.length > VISIBLE_TAIL + 2;
  const tail = collapsed ? trail.slice(-VISIBLE_TAIL) : trail.slice(1);

  const dropProps = (entry: BreadcrumbDto, isLast: boolean) => {
    // The last crumb is the folder you are already in; dropping there is a no-op that
    // would still fire a round of move requests.
    if (!onDropItems || isLast) return {};

    return {
      onDragOver: (event: React.DragEvent) => {
        if (!Array.from(event.dataTransfer.types).includes(DRIVE_DRAG_MIME)) return;
        if (canAcceptDrop && !canAcceptDrop(entry.id)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOver(entry.id);
      },
      onDragLeave: () => setOver(null),
      onDrop: (event: React.DragEvent) => {
        setOver(null);
        onDropItems(entry.id, event);
      },
    };
  };

  return (
    <nav aria-label="Breadcrumb" className={cn('min-w-0', className)}>
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        <li
          className={cn(
            'flex min-w-0 items-center gap-1 rounded px-1',
            over === root.id && 'bg-primary/10 outline outline-2 outline-primary',
          )}
          {...dropProps(root, trail.length === 1)}
        >
          <RootIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Crumb entry={root} isLast={trail.length === 1} />
        </li>

        {collapsed ? (
          <li className="flex items-center gap-1 text-muted-foreground" aria-hidden="true">
            <ChevronRight className="size-4 shrink-0" />
            <span className="px-1">…</span>
          </li>
        ) : null}

        {tail.map((entry, index) => (
          <li key={entry.id} className="flex min-w-0 items-center gap-1">
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span
              className={cn(
                'min-w-0 rounded px-1',
                over === entry.id && 'bg-primary/10 outline outline-2 outline-primary',
              )}
              {...dropProps(entry, index === tail.length - 1)}
            >
              <Crumb entry={entry} isLast={index === tail.length - 1} />
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Crumb({ entry, isLast }: { entry: BreadcrumbDto; isLast: boolean }) {
  if (isLast) {
    return (
      <span className="truncate font-medium" aria-current="page">
        {entry.name}
      </span>
    );
  }
  return (
    <Link
      href={`/drive/${entry.id}`}
      className="truncate text-muted-foreground transition-colors hover:text-foreground hover:underline"
    >
      {entry.name}
    </Link>
  );
}

export function FolderIcon({ className }: { className?: string }) {
  return <FolderClosed className={cn('size-4', className)} aria-hidden="true" />;
}
