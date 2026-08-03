'use client';

import { MoveRight, Star, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * What you can do to everything you have highlighted.
 *
 * Replaces the ordinary toolbar rather than sitting above it: with a selection live, sort
 * order and view mode are not what anyone is reaching for, and two rows of controls make
 * people hunt. It disappears the moment the selection is empty.
 *
 * Only three actions. Move, star and trash are the operations people do to twenty files
 * at once; renaming or previewing twenty files is not a thing, and offering it would just
 * make the useful buttons harder to find.
 */
export function SelectionBar({
  count,
  canMove,
  canTrash,
  isBusy,
  onMove,
  onStar,
  onTrash,
  onClear,
}: {
  count: number;
  /** False when nothing selected may be moved — the server would refuse every one. */
  canMove: boolean;
  canTrash: boolean;
  isBusy: boolean;
  onMove: () => void;
  onStar: () => void;
  onTrash: () => void;
  onClear: () => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 p-2"
      role="toolbar"
      aria-label={`Actions for ${count} selected items`}
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={onClear}
        aria-label="Clear selection"
      >
        <X className="size-4" aria-hidden="true" />
      </Button>

      <span className="text-sm font-medium" aria-live="polite">
        {count} selected
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={isBusy || !canMove} onClick={onMove}>
          <MoveRight className="mr-2 size-4" aria-hidden="true" />
          Move
        </Button>
        <Button variant="outline" size="sm" disabled={isBusy} onClick={onStar}>
          <Star className="mr-2 size-4" aria-hidden="true" />
          Star
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={isBusy || !canTrash}
          onClick={onTrash}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="mr-2 size-4" aria-hidden="true" />
          Move to trash
        </Button>
      </div>
    </div>
  );
}
