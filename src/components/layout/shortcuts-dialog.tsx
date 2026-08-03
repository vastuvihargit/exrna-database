'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * The list of shortcuts, reachable with `?`.
 *
 * Shortcuts nobody can discover are shortcuts nobody uses, and a drive full of scientists
 * is not a place where people go reading documentation to find them. `?` is the
 * convention; this is what it opens.
 */
const GROUPS: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: 'Anywhere',
    rows: [
      ['/', 'Jump to search'],
      ['?', 'Show this list'],
      ['Esc', 'Close a dialog, or clear the selection'],
    ],
  },
  {
    title: 'In a folder',
    rows: [
      ['Click', 'Open a folder, or preview a file'],
      ['Ctrl / ⌘ + click', 'Add one item to the selection'],
      ['Shift + click', 'Select everything between'],
      ['Ctrl / ⌘ + A', 'Select everything on the page'],
      ['Delete', 'Move the selection to trash'],
      ['Right-click', 'All actions for an item'],
      ['Drag', 'Move onto a folder, or onto the path to move up'],
    ],
  },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard and mouse shortcuts</DialogTitle>
          <DialogDescription>Everything here also has a button — these are just faster.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.title}
              </h3>
              <dl className="space-y-1.5">
                {group.rows.map(([keys, meaning]) => (
                  <div key={keys} className="flex items-baseline justify-between gap-4 text-sm">
                    <dt className="shrink-0">
                      <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {keys}
                      </kbd>
                    </dt>
                    <dd className="min-w-0 flex-1 text-right text-muted-foreground">{meaning}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
