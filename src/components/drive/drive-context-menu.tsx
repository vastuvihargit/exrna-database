'use client';

import type { ReactNode } from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { ActionGroup } from './file-actions-menu';

/**
 * Right-click on a row.
 *
 * Everyone right-clicks a file — it is the first thing people try in any file manager,
 * and until now nothing happened, leaving the ⋮ button as the only route to any action.
 * The menu is built from the same groups the ⋮ button renders, so the two can never drift
 * apart and offer different things.
 *
 * When the click lands on part of a multi-item selection the menu says so and offers the
 * bulk actions instead, because "delete" meaning "delete one of the twelve things I have
 * highlighted" is how people lose work.
 */
export function DriveContextMenu({
  children,
  groups,
  bulk,
}: {
  children: ReactNode;
  groups: ActionGroup[];
  /** Present when the right-clicked row is part of a selection of more than one. */
  bulk?: { count: number; groups: ActionGroup[] };
}) {
  const shown = bulk ? bulk.groups : groups;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {bulk ? <ContextMenuLabel>{bulk.count} items selected</ContextMenuLabel> : null}
        {shown.map((group, index) => (
          <div key={group[0]?.key ?? index}>
            {index > 0 || bulk ? <ContextMenuSeparator /> : null}
            {group.map((item) => {
              const Icon = item.icon;
              return (
                <ContextMenuItem
                  key={item.key}
                  disabled={item.disabled}
                  onSelect={item.onSelect}
                  className={item.destructive ? 'text-destructive focus:text-destructive' : undefined}
                >
                  <Icon className="mr-2 size-4" aria-hidden="true" /> {item.label}
                  {item.trailing ? (
                    <span className="ml-auto text-xs text-muted-foreground">{item.trailing}</span>
                  ) : null}
                </ContextMenuItem>
              );
            })}
          </div>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
