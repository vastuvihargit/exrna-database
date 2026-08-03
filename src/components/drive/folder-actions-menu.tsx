'use client';

import {
  Archive,
  ArchiveRestore,
  Copy,
  Info,
  MoreVertical,
  MoveRight,
  PencilLine,
  Share2,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { FolderDto } from '@/hooks/use-drive';
import type { ActionGroup } from './file-actions-menu';

export interface FolderActions {
  onRename: (folder: FolderDto) => void;
  onMove: (folder: FolderDto) => void;
  onCopy: (folder: FolderDto) => void;
  onTrash: (folder: FolderDto) => void;
  onArchive: (folder: FolderDto, archived: boolean) => void;
  onStar: (folder: FolderDto, starred: boolean) => void;
  onDetails: (folder: FolderDto) => void;
  onShare: (folder: FolderDto) => void;
}

/** Shared by the ⋮ menu and the right-click menu — see `fileActionGroups`. */
export function folderActionGroups(folder: FolderDto, actions: FolderActions): ActionGroup[] {
  const { capabilities } = folder;

  return [
    [
      {
        key: 'star',
        label: folder.isStarred ? 'Remove star' : 'Add star',
        icon: folder.isStarred ? StarOff : Star,
        onSelect: () => actions.onStar(folder, !folder.isStarred),
      },
      {
        key: 'details',
        label: 'Details',
        icon: Info,
        onSelect: () => actions.onDetails(folder),
      },
      {
        key: 'share',
        label: 'Share',
        icon: Share2,
        disabled: !capabilities.canShare && !capabilities.canManageAccess,
        onSelect: () => actions.onShare(folder),
      },
    ],
    [
      {
        key: 'rename',
        label: 'Rename',
        icon: PencilLine,
        disabled: !capabilities.canRename,
        onSelect: () => actions.onRename(folder),
      },
      {
        key: 'move',
        label: 'Move to…',
        icon: MoveRight,
        disabled: !capabilities.canMove,
        onSelect: () => actions.onMove(folder),
      },
      {
        key: 'copy',
        label: 'Make a copy',
        icon: Copy,
        disabled: !capabilities.canCopy,
        onSelect: () => actions.onCopy(folder),
      },
    ],
    [
      folder.status === 'archived'
        ? {
            key: 'unarchive',
            label: 'Unarchive',
            icon: ArchiveRestore,
            disabled: !capabilities.canRestore,
            onSelect: () => actions.onArchive(folder, false),
          }
        : {
            key: 'archive',
            label: 'Archive',
            icon: Archive,
            disabled: !capabilities.canArchive,
            onSelect: () => actions.onArchive(folder, true),
          },
      {
        key: 'trash',
        label: 'Move to trash',
        icon: Trash2,
        disabled: !capabilities.canDelete,
        destructive: true,
        onSelect: () => actions.onTrash(folder),
      },
    ],
  ];
}

/**
 * Actions are shown but disabled when the viewer lacks the permission, rather than
 * hidden. Hiding them makes the interface look different for different people and
 * leaves users unable to work out what to ask for.
 */
export function FolderActionsMenu({
  folder,
  actions,
  align = 'end',
}: {
  folder: FolderDto;
  actions: FolderActions;
  align?: 'start' | 'end';
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Actions for ${folder.name}`}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreVertical className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align={align} className="w-52">
        {folderActionGroups(folder, actions).map((group, index) => (
          <div key={group[0]?.key ?? index}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            {group.map((item) => {
              const Icon = item.icon;
              return (
                <DropdownMenuItem
                  key={item.key}
                  disabled={item.disabled}
                  onSelect={item.onSelect}
                  className={item.destructive ? 'text-destructive focus:text-destructive' : undefined}
                >
                  <Icon className="mr-2 size-4" aria-hidden="true" /> {item.label}
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
