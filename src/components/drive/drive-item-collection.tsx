'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { FolderClosed, Lock, Star } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import type { FolderDto } from '@/hooks/use-drive';
import type { FileDto } from '@/hooks/use-files';
import { DriveError } from './drive-browser';
import { FileIcon } from './file-icon';

/**
 * Flat list used by Recent, Starred, Trash, Archive and the Home page.
 *
 * It shows **files as well as folders**. Its predecessor rendered folders only while the
 * endpoints behind it had been returning both all along, so starring a file reported
 * success and then showed an empty Starred page, and a trashed file could not be
 * restored from anywhere in the product.
 *
 * These views list items from all over the drive, so each row leads with the drive the
 * item lives in rather than a breadcrumb: when you did not navigate somewhere, "which
 * drive is this in" is the fact you are missing.
 */
export function DriveItemCollection({
  folders,
  files,
  isLoading,
  error,
  emptyTitle,
  emptyDescription,
  onOpenFile,
  renderFolderAction,
  renderFileAction,
}: {
  folders: FolderDto[] | undefined;
  files?: FileDto[] | undefined;
  isLoading: boolean;
  error: unknown;
  emptyTitle: string;
  emptyDescription: string;
  /** Omitted where opening makes no sense — a trashed file has nothing to show. */
  onOpenFile?: (file: FileDto) => void;
  renderFolderAction?: (folder: FolderDto) => ReactNode;
  renderFileAction?: (file: FileDto) => ReactNode;
}) {
  if (error) return <DriveError error={error} />;

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  const folderList = folders ?? [];
  const fileList = files ?? [];

  if (folderList.length === 0 && fileList.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-md border border-dashed p-12 text-center">
        <FolderClosed className="size-10 text-muted-foreground" aria-hidden="true" />
        <p className="mt-4 font-medium">{emptyTitle}</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{emptyDescription}</p>
      </div>
    );
  }

  return (
    <ul className="divide-y rounded-md border">
      {/* Folders first, then files — the order every drive uses. */}
      {folderList.map((folder) => (
        <li key={`folder-${folder.id}`} className="flex items-center gap-3 p-3">
          <FolderClosed className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            {folder.deletedAt ? (
              <span className="block truncate font-medium">{folder.name}</span>
            ) : (
              <Link
                href={`/drive/${folder.id}`}
                className="block truncate font-medium hover:underline"
              >
                {folder.name}
              </Link>
            )}
            <p className="truncate text-xs text-muted-foreground">
              {driveLabel(folder.driveType)} · {folder.deletedAt ? 'Deleted' : 'Modified'}{' '}
              {formatRelativeTime(folder.deletedAt ?? folder.updatedAt)}
            </p>
          </div>
          {folder.isStarred ? (
            <Star className="size-4 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />
          ) : null}
          {renderFolderAction?.(folder)}
        </li>
      ))}

      {fileList.map((file) => (
        <li key={`file-${file.id}`} className="flex items-center gap-3 p-3">
          <FileIcon category={file.category} className="size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            {onOpenFile ? (
              <button
                type="button"
                onClick={() => onOpenFile(file)}
                className="block max-w-full truncate text-left font-medium hover:underline"
              >
                {file.displayName}
              </button>
            ) : (
              <span className="block truncate font-medium">{file.displayName}</span>
            )}
            <p className="truncate text-xs text-muted-foreground">
              {driveLabel(file.driveType)} · {formatBytes(file.sizeBytes)}
              {file.versionCount > 1 ? ` · ${file.versionCount} versions` : ''} ·{' '}
              {file.deletedAt ? 'Deleted' : 'Modified'}{' '}
              {formatRelativeTime(file.deletedAt ?? file.updatedAt)}
            </p>
          </div>
          {file.approvalStatus === 'approved' ? (
            <Badge className="hidden shrink-0 bg-emerald-600 text-[10px] hover:bg-emerald-600 sm:inline-flex">
              Approved
            </Badge>
          ) : null}
          {!file.inheritPermissions ? (
            <Lock className="size-4 shrink-0 text-muted-foreground" aria-label="Restricted access" />
          ) : null}
          {file.isStarred ? (
            <Star className="size-4 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />
          ) : null}
          {renderFileAction?.(file)}
        </li>
      ))}
    </ul>
  );
}

function driveLabel(driveType: 'my' | 'department' | 'project'): string {
  if (driveType === 'department') return 'Department drive';
  if (driveType === 'project') return 'Project drive';
  return 'My Drive';
}
