'use client';

import type { LucideIcon } from 'lucide-react';
import {
  Copy,
  Download,
  Eye,
  FolderOpen,
  History,
  Info,
  MoreVertical,
  MoveRight,
  PencilLine,
  Share2,
  Star,
  StarOff,
  Trash2,
  Upload,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { FileDto } from '@/hooks/use-files';

export interface FileActions {
  onPreview: (file: FileDto) => void;
  onDownload: (file: FileDto) => void;
  onRename: (file: FileDto) => void;
  onMove: (file: FileDto) => void;
  onCopy: (file: FileDto) => void;
  onTrash: (file: FileDto) => void;
  onStar: (file: FileDto, starred: boolean) => void;
  onDetails: (file: FileDto) => void;
  onVersions: (file: FileDto) => void;
  onNewVersion: (file: FileDto) => void;
  onShare?: (file: FileDto) => void;
  /** Offered only where the viewer is not already looking at the containing folder. */
  onOpenLocation?: (file: FileDto) => void;
}

/**
 * One description of what can be done to an item, rendered by two different menus.
 *
 * The ⋮ button and the right-click menu are separate Radix primitives with incompatible
 * item components, so they cannot share a rendered subtree — but they must never offer
 * different actions, which is what happens the moment the lists are written out twice.
 * They share this instead, and each renders it with its own primitive.
 */
export interface ActionItem {
  key: string;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  destructive?: boolean;
  /** Right-aligned hint, e.g. how many versions exist. */
  trailing?: string;
  onSelect: () => void;
}

/** Groups render with a separator between them. */
export type ActionGroup = ActionItem[];

export function fileActionGroups(file: FileDto, actions: FileActions): ActionGroup[] {
  const { capabilities } = file;

  const open: ActionGroup = [
    {
      key: 'preview',
      label: 'Preview',
      icon: Eye,
      disabled: !capabilities.canPreview || !file.previewable,
      onSelect: () => actions.onPreview(file),
    },
    {
      key: 'download',
      label: 'Download',
      icon: Download,
      disabled: !capabilities.canDownload,
      onSelect: () => actions.onDownload(file),
    },
  ];

  if (actions.onOpenLocation) {
    open.push({
      key: 'location',
      label: 'Open containing folder',
      icon: FolderOpen,
      onSelect: () => actions.onOpenLocation?.(file),
    });
  }

  const inspect: ActionGroup = [
    {
      key: 'star',
      label: file.isStarred ? 'Remove star' : 'Add star',
      icon: file.isStarred ? StarOff : Star,
      onSelect: () => actions.onStar(file, !file.isStarred),
    },
    {
      key: 'details',
      label: 'Details',
      icon: Info,
      onSelect: () => actions.onDetails(file),
    },
    {
      key: 'versions',
      label: 'Version history',
      icon: History,
      ...(file.versionCount > 1 ? { trailing: String(file.versionCount) } : {}),
      onSelect: () => actions.onVersions(file),
    },
  ];

  if (actions.onShare) {
    inspect.push({
      key: 'share',
      label: 'Share',
      icon: Share2,
      disabled: !capabilities.canShare && !capabilities.canManageAccess,
      onSelect: () => actions.onShare?.(file),
    });
  }

  const change: ActionGroup = [
    {
      key: 'new-version',
      label: 'Upload new version',
      icon: Upload,
      disabled: !capabilities.canUploadVersion,
      onSelect: () => actions.onNewVersion(file),
    },
    {
      key: 'rename',
      label: 'Rename',
      icon: PencilLine,
      disabled: !capabilities.canRename,
      onSelect: () => actions.onRename(file),
    },
    {
      key: 'move',
      label: 'Move to…',
      icon: MoveRight,
      disabled: !capabilities.canMove,
      onSelect: () => actions.onMove(file),
    },
    {
      key: 'copy',
      label: 'Make a copy',
      icon: Copy,
      disabled: !capabilities.canCopy,
      onSelect: () => actions.onCopy(file),
    },
  ];

  const remove: ActionGroup = [
    {
      key: 'trash',
      label: 'Move to trash',
      icon: Trash2,
      disabled: !capabilities.canDelete,
      destructive: true,
      onSelect: () => actions.onTrash(file),
    },
  ];

  return [open, inspect, change, remove];
}

/**
 * Actions are shown but disabled when the viewer lacks the permission, rather than
 * hidden — same rule as the folder menu. An approved file reports `canRename: false`
 * from the server, so the read-only rule needs no separate handling here.
 */
export function FileActionsMenu({
  file,
  actions,
  align = 'end',
}: {
  file: FileDto;
  actions: FileActions;
  align?: 'start' | 'end';
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Actions for ${file.displayName}`}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreVertical className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align={align} className="w-56">
        {fileActionGroups(file, actions).map((group, index) => (
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
                  {item.trailing ? (
                    <span className="ml-auto text-xs text-muted-foreground">{item.trailing}</span>
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
