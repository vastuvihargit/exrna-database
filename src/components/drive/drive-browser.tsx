'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  FolderClosed,
  FolderPlus,
  FolderUp,
  LayoutGrid,
  List,
  Lock,
  MoveRight,
  Search,
  Star,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError } from '@/lib/api-client';
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils';
import { itemKey, useSelection, type Selection } from '@/hooks/use-selection';
import {
  useArchiveFolder,
  useCopyFolder,
  useFolderChildren,
  useMoveFolder,
  useRestoreFolder,
  useStarFolder,
  useTrashFolder,
  type BreadcrumbDto,
  type FolderDto,
  type ListQuery,
} from '@/hooks/use-drive';
import {
  useCopyFile,
  useMoveFile,
  useRestoreFile,
  useStarFile,
  useTrashFile,
  type FileDto,
} from '@/hooks/use-files';
import { useUploadContext } from '@/components/providers/upload-provider';
import {
  DRIVE_DRAG_MIME,
  NEW_FOLDER_EVENT,
  UPLOAD_TARGET_EVENT,
  type UploadTargetDetail,
} from './drive-intents';
import { DriveBreadcrumbs } from './drive-breadcrumbs';
import { DriveContextMenu } from './drive-context-menu';
import {
  FileActionsMenu,
  fileActionGroups,
  type ActionGroup,
  type FileActions,
} from './file-actions-menu';
import { FileDetailsPanel } from './file-details-panel';
import { FileIcon } from './file-icon';
import { FilePreviewDialog } from './file-preview-dialog';
import {
  FolderActionsMenu,
  folderActionGroups,
  type FolderActions,
} from './folder-actions-menu';
import { FolderDetailsPanel } from './folder-details-panel';
import { ShareDialog } from './share-dialog';
import { FolderPickerDialog } from './folder-picker-dialog';
import { NewFolderDialog } from './new-folder-dialog';
import { NewVersionDialog, type PendingVersion } from './new-version-dialog';
import { RenameFileDialog } from './rename-file-dialog';
import { RenameFolderDialog } from './rename-folder-dialog';
import { SelectionBar } from './selection-bar';
import { UploadDropzone } from './upload-dropzone';

const PAGE_SIZE = 50;

/** Long enough to read the sentence and reach for Undo, short enough not to pile up. */
const UNDO_MS = 10_000;

type ViewMode = 'list' | 'grid';

interface BulkOutcome {
  ok: number;
  failed: number;
  firstError?: string;
}

/**
 * Runs a bulk action one item at a time and never gives up on the rest.
 *
 * Sequential on purpose. Moving twenty files into one folder in parallel makes the server
 * race itself over the same destination, and a failure in the middle of a parallel batch
 * cannot be attributed to anything the user can act on. One at a time is slower and it is
 * the version whose report is true.
 */
async function runBulk<T>(items: T[], operation: (item: T) => Promise<unknown>): Promise<BulkOutcome> {
  let ok = 0;
  let failed = 0;
  let firstError: string | undefined;

  for (const item of items) {
    try {
      await operation(item);
      ok += 1;
    } catch (error) {
      failed += 1;
      if (firstError === undefined && error instanceof ApiError) firstError = error.message;
    }
  }

  return { ok, failed, ...(firstError ? { firstError } : {}) };
}

/**
 * Says what actually happened, including when it only half worked.
 *
 * A bulk action across a mixed selection routinely succeeds for some items and is refused
 * for others — permissions differ per item, and an approved file cannot be renamed or
 * moved. Reporting a flat "Done" would be a lie the user discovers later.
 */
function reportBulk(outcome: BulkOutcome, done: string, failedVerb: string) {
  const total = outcome.ok + outcome.failed;

  if (outcome.failed === 0) {
    toast.success(`${done} ${outcome.ok} item${outcome.ok === 1 ? '' : 's'}`);
    return;
  }

  if (outcome.ok === 0) {
    toast.error(`Could not ${failedVerb} ${total === 1 ? 'that item' : 'any of those items'}`, {
      description: outcome.firstError,
    });
    return;
  }

  toast.warning(`${done} ${outcome.ok} of ${total}`, {
    description:
      outcome.firstError ??
      `${outcome.failed} could not be changed — you may not have permission on all of them.`,
  });
}

export function DriveBrowser({
  folder,
  breadcrumbs,
  isLoading,
  error,
}: {
  folder: FolderDto | undefined;
  breadcrumbs: BreadcrumbDto[];
  isLoading: boolean;
  error: unknown;
}) {
  const router = useRouter();
  const [view, setView] = useState<ViewMode>('list');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<ListQuery['sort']>('name');
  const [order, setOrder] = useState<ListQuery['order']>('asc');
  const [search, setSearch] = useState('');

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renaming, setRenaming] = useState<FolderDto | null>(null);
  const [detailsFor, setDetailsFor] = useState<FolderDto | null>(null);
  const [moving, setMoving] = useState<FolderDto | null>(null);
  const [copying, setCopying] = useState<FolderDto | null>(null);
  const [trashing, setTrashing] = useState<FolderDto | null>(null);
  const [sharingFolder, setSharingFolder] = useState<FolderDto | null>(null);

  const [renamingFile, setRenamingFile] = useState<FileDto | null>(null);
  const [fileDetailsFor, setFileDetailsFor] = useState<FileDto | null>(null);
  const [previewing, setPreviewing] = useState<FileDto | null>(null);
  const [movingFile, setMovingFile] = useState<FileDto | null>(null);
  const [copyingFile, setCopyingFile] = useState<FileDto | null>(null);
  const [sharingFile, setSharingFile] = useState<FileDto | null>(null);

  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkTrashOpen, setBulkTrashOpen] = useState(false);
  const [isBulkRunning, setBulkRunning] = useState(false);

  const query: ListQuery = useMemo(
    () => ({ page, pageSize: PAGE_SIZE, sort, order, ...(search ? { search } : {}) }),
    [page, sort, order, search],
  );
  const children = useFolderChildren(folder?.id ?? null, query);

  const move = useMoveFolder();
  const copy = useCopyFolder();
  const trash = useTrashFolder();
  const restoreFolder = useRestoreFolder();
  const archive = useArchiveFolder();
  const star = useStarFolder();

  const moveFile = useMoveFile();
  const copyFile = useCopyFile();
  const trashFile = useTrashFile();
  const restoreFile = useRestoreFile();
  const starFile = useStarFile();

  const uploader = useUploadContext();
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const versionPicker = useRef<HTMLInputElement>(null);
  const versionTarget = useRef<FileDto | null>(null);
  const [pendingVersion, setPendingVersion] = useState<PendingVersion | null>(null);

  const folders = useMemo(() => children.data?.folders ?? [], [children.data]);
  const files = useMemo(() => children.data?.files ?? [], [children.data]);

  // Folders first, then files — the same order the list renders, so Shift-click extends
  // over the range the user can actually see.
  const orderedKeys = useMemo(
    () => [
      ...folders.map((entry) => itemKey('folder', entry.id)),
      ...files.map((entry) => itemKey('file', entry.id)),
    ],
    [folders, files],
  );
  const selection = useSelection(orderedKeys);
  const { clear: clearSelection } = selection;

  const selectedFolders = useMemo(
    () => folders.filter((entry) => selection.has(itemKey('folder', entry.id))),
    [folders, selection],
  );
  const selectedFiles = useMemo(
    () => files.filter((entry) => selection.has(itemKey('file', entry.id))),
    [files, selection],
  );

  // Opening a different folder must not carry a selection with it: the ids would still be
  // "selected" and a bulk action would act on things no longer on screen.
  useEffect(() => {
    clearSelection();
  }, [folder?.id, page, clearSelection]);

  const canUploadHere = Boolean(folder?.capabilities.canUpload) && folder?.status === 'active';

  const startUpload = useCallback(
    (dropped: File[]) => {
      if (!folder || dropped.length === 0) return;
      if (!canUploadHere) {
        toast.error('You do not have permission to upload to this folder');
        return;
      }
      uploader.enqueue(dropped, { folderId: folder.id });
    },
    [folder, canUploadHere, uploader],
  );

  // Claims the sidebar's "New folder" intent while a folder is open, so the folder is
  // created where the user is looking rather than always in My Drive.
  const canCreateHere = Boolean(folder?.capabilities.canCreateFolder) && folder?.status === 'active';
  useEffect(() => {
    if (!canCreateHere) return undefined;
    const claim = (event: Event) => {
      event.preventDefault();
      setNewFolderOpen(true);
    };
    window.addEventListener(NEW_FOLDER_EVENT, claim);
    return () => window.removeEventListener(NEW_FOLDER_EVENT, claim);
  }, [canCreateHere]);

  // Answers the sidebar's New menu when it asks where an upload should go, so files
  // chosen outside this component land in the folder the user is looking at.
  useEffect(() => {
    if (!canUploadHere || !folder) return undefined;
    const answer = (event: Event) => {
      (event as CustomEvent<UploadTargetDetail>).detail.folderId = folder.id;
    };
    window.addEventListener(UPLOAD_TARGET_EVENT, answer);
    return () => window.removeEventListener(UPLOAD_TARGET_EVENT, answer);
  }, [canUploadHere, folder]);

  const run = async (promise: Promise<unknown>, success: string, failure: string) => {
    try {
      await promise;
      toast.success(success);
      return true;
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : failure);
      return false;
    }
  };

  /** Moves a set of items into a folder and offers to put them back. */
  const moveItems = useCallback(
    async (targetFolderId: string, movedFolders: FolderDto[], movedFiles: FileDto[]) => {
      const from = folder?.id;
      const count = movedFolders.length + movedFiles.length;
      if (count === 0 || !from || targetFolderId === from) return;

      setBulkRunning(true);
      const folderOutcome = await runBulk(movedFolders, (entry) =>
        move.mutateAsync({ folderId: entry.id, targetParentFolderId: targetFolderId }),
      );
      const fileOutcome = await runBulk(movedFiles, (entry) =>
        moveFile.mutateAsync({ fileId: entry.id, targetFolderId }),
      );
      setBulkRunning(false);

      const combined: BulkOutcome = {
        ok: folderOutcome.ok + fileOutcome.ok,
        failed: folderOutcome.failed + fileOutcome.failed,
        ...(folderOutcome.firstError ?? fileOutcome.firstError
          ? { firstError: folderOutcome.firstError ?? fileOutcome.firstError }
          : {}),
      };

      if (combined.ok === 0) {
        reportBulk(combined, 'Moved', 'move');
        return;
      }

      const undo = async () => {
        const back = await runBulk(
          [
            ...movedFolders.map((entry) => () => move.mutateAsync({ folderId: entry.id, targetParentFolderId: from })),
            ...movedFiles.map((entry) => () => moveFile.mutateAsync({ fileId: entry.id, targetFolderId: from })),
          ],
          (operation) => operation(),
        );
        if (back.failed > 0) toast.error('Could not put everything back', { description: back.firstError });
        else toast.success('Move undone');
      };

      if (combined.failed > 0) {
        reportBulk(combined, 'Moved', 'move');
      } else {
        toast.success(`Moved ${combined.ok} item${combined.ok === 1 ? '' : 's'}`, {
          duration: UNDO_MS,
          action: { label: 'Undo', onClick: () => void undo() },
        });
      }

      clearSelection();
    },
    [clearSelection, folder?.id, move, moveFile],
  );

  /**
   * Trashing a file happens immediately, with Undo.
   *
   * A confirmation dialog before a reversible action is the wrong tool: people learn to
   * dismiss it without reading, and it still cannot help once they have clicked through.
   * Undo can. Folders keep their dialog, because "everything inside goes too" is a
   * consequence you cannot see from the row you clicked.
   */
  const trashOneFile = useCallback(
    async (target: FileDto) => {
      try {
        await trashFile.mutateAsync(target.id);
        toast.success(`Moved "${target.displayName}" to trash`, {
          duration: UNDO_MS,
          action: {
            label: 'Undo',
            onClick: () => {
              void restoreFile
                .mutateAsync(target.id)
                .then(() => toast.success(`Restored "${target.displayName}"`))
                .catch((caught: unknown) =>
                  toast.error(caught instanceof ApiError ? caught.message : 'Could not restore it'),
                );
            },
          },
        });
      } catch (caught) {
        toast.error(caught instanceof ApiError ? caught.message : 'Could not move the file to trash');
      }
    },
    [restoreFile, trashFile],
  );

  const trashOneFolder = useCallback(
    async (target: FolderDto) => {
      try {
        await trash.mutateAsync(target.id);
        toast.success(`Moved "${target.name}" to trash`, {
          duration: UNDO_MS,
          action: {
            label: 'Undo',
            onClick: () => {
              void restoreFolder
                .mutateAsync(target.id)
                .then(() => toast.success(`Restored "${target.name}"`))
                .catch((caught: unknown) =>
                  toast.error(caught instanceof ApiError ? caught.message : 'Could not restore it'),
                );
            },
          },
        });
      } catch (caught) {
        toast.error(caught instanceof ApiError ? caught.message : 'Could not move the folder to trash');
      }
    },
    [restoreFolder, trash],
  );

  const bulkTrash = useCallback(async () => {
    setBulkRunning(true);
    const folderIds = selectedFolders.map((entry) => entry.id);
    const fileIds = selectedFiles.map((entry) => entry.id);

    const folderOutcome = await runBulk(folderIds, (id) => trash.mutateAsync(id));
    const fileOutcome = await runBulk(fileIds, (id) => trashFile.mutateAsync(id));
    setBulkRunning(false);
    setBulkTrashOpen(false);

    const combined: BulkOutcome = {
      ok: folderOutcome.ok + fileOutcome.ok,
      failed: folderOutcome.failed + fileOutcome.failed,
      ...(folderOutcome.firstError ?? fileOutcome.firstError
        ? { firstError: folderOutcome.firstError ?? fileOutcome.firstError }
        : {}),
    };

    if (combined.failed > 0 || combined.ok === 0) {
      reportBulk(combined, 'Trashed', 'move to trash');
    } else {
      toast.success(`Moved ${combined.ok} item${combined.ok === 1 ? '' : 's'} to trash`, {
        duration: UNDO_MS,
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              const back = await runBulk(
                [
                  ...folderIds.map((id) => () => restoreFolder.mutateAsync(id)),
                  ...fileIds.map((id) => () => restoreFile.mutateAsync(id)),
                ],
                (operation) => operation(),
              );
              if (back.failed > 0) toast.error('Could not restore everything', { description: back.firstError });
              else toast.success('Restored');
            })();
          },
        },
      });
    }

    clearSelection();
  }, [clearSelection, restoreFile, restoreFolder, selectedFiles, selectedFolders, trash, trashFile]);

  const bulkStar = useCallback(async () => {
    setBulkRunning(true);
    // Star everything unless it is already all starred, in which case unstar — the same
    // thing the single-item toggle does, scaled up.
    const selected = [...selectedFolders, ...selectedFiles];
    const starred = !selected.every((entry) => entry.isStarred);

    const folderOutcome = await runBulk(selectedFolders, (entry) =>
      star.mutateAsync({ folderId: entry.id, starred }),
    );
    const fileOutcome = await runBulk(selectedFiles, (entry) =>
      starFile.mutateAsync({ fileId: entry.id, starred }),
    );
    setBulkRunning(false);

    reportBulk(
      {
        ok: folderOutcome.ok + fileOutcome.ok,
        failed: folderOutcome.failed + fileOutcome.failed,
        ...(folderOutcome.firstError ?? fileOutcome.firstError
          ? { firstError: folderOutcome.firstError ?? fileOutcome.firstError }
          : {}),
      },
      starred ? 'Starred' : 'Unstarred',
      starred ? 'star' : 'unstar',
    );
  }, [selectedFiles, selectedFolders, star, starFile]);

  // ── Dragging ───────────────────────────────────────────────────────────────
  // The keys being dragged are kept in a ref because `dragover` is only allowed to see
  // the *types* on the data transfer, never the payload. Without this a folder could not
  // tell whether it was one of the things being dragged onto itself.
  const draggingKeys = useRef<string[]>([]);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const beginDrag = useCallback(
    (event: React.DragEvent, key: string) => {
      const keys = selection.has(key) && selection.count > 1 ? selection.keys : [key];
      draggingKeys.current = keys;
      event.dataTransfer.setData(DRIVE_DRAG_MIME, keys.join(','));
      event.dataTransfer.effectAllowed = 'move';
    },
    [selection],
  );

  const endDrag = useCallback(() => {
    draggingKeys.current = [];
    setDropTargetId(null);
  }, []);

  const canDropOn = useCallback((targetFolderId: string) => {
    const keys = draggingKeys.current;
    if (keys.length === 0) return false;
    // Dropping a folder onto itself is the one move the server cannot make sense of.
    return !keys.includes(itemKey('folder', targetFolderId));
  }, []);

  const dropOnFolder = useCallback(
    (event: React.DragEvent, targetFolderId: string) => {
      if (!Array.from(event.dataTransfer.types).includes(DRIVE_DRAG_MIME)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropTargetId(null);

      const keys = event.dataTransfer.getData(DRIVE_DRAG_MIME).split(',').filter(Boolean);
      draggingKeys.current = [];

      const draggedFolders = folders.filter(
        (entry) => keys.includes(itemKey('folder', entry.id)) && entry.id !== targetFolderId,
      );
      const draggedFiles = files.filter((entry) => keys.includes(itemKey('file', entry.id)));
      void moveItems(targetFolderId, draggedFolders, draggedFiles);
    },
    [files, folders, moveItems],
  );

  const dragOverFolder = useCallback(
    (event: React.DragEvent, targetFolderId: string) => {
      if (!Array.from(event.dataTransfer.types).includes(DRIVE_DRAG_MIME)) return;
      if (!canDropOn(targetFolderId)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      setDropTargetId(targetFolderId);
    },
    [canDropOn],
  );

  // ── Keyboard ───────────────────────────────────────────────────────────────
  const hasSelection = selection.count > 0;
  const selectAll = selection.selectAll;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || isDialogOpen()) return;

      if (event.key === 'Escape' && hasSelection) {
        clearSelection();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAll();
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && hasSelection) {
        event.preventDefault();
        setBulkTrashOpen(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection, hasSelection, selectAll]);

  const actions: FolderActions = {
    onRename: setRenaming,
    onMove: setMoving,
    onCopy: setCopying,
    onTrash: setTrashing,
    onDetails: setDetailsFor,
    onShare: setSharingFolder,
    onArchive: (target, archived) => {
      void run(
        archive.mutateAsync({ folderId: target.id, archived }),
        archived ? 'Archived' : 'Restored from archive',
        'Could not change the archive state',
      );
    },
    onStar: (target, starred) => {
      void run(
        star.mutateAsync({ folderId: target.id, starred }),
        starred ? 'Added to Starred' : 'Removed from Starred',
        'Could not update the star',
      );
    },
  };

  const fileActions: FileActions = {
    onPreview: setPreviewing,
    onDetails: setFileDetailsFor,
    onVersions: setFileDetailsFor,
    onRename: setRenamingFile,
    onMove: setMovingFile,
    onCopy: setCopyingFile,
    onShare: setSharingFile,
    onTrash: (target) => void trashOneFile(target),
    // A plain link, not fetch: the browser's own download manager handles large files,
    // resumption and the save dialog far better than anything JavaScript can do here.
    onDownload: (target) => {
      window.location.href = `/api/files/${target.id}/download`;
    },
    onStar: (target, starred) => {
      void run(
        starFile.mutateAsync({ fileId: target.id, starred }),
        starred ? 'Added to Starred' : 'Removed from Starred',
        'Could not update the star',
      );
    },
    onNewVersion: (target) => {
      versionTarget.current = target;
      versionPicker.current?.click();
    },
  };

  /** Offered by the right-click menu when the click lands on a multi-item selection. */
  const bulkGroups: ActionGroup[] = [
    [
      {
        key: 'bulk-move',
        label: 'Move to…',
        icon: MoveRight,
        disabled: !canMoveSelection(selectedFolders, selectedFiles),
        onSelect: () => setBulkMoveOpen(true),
      },
      {
        key: 'bulk-star',
        label: 'Star',
        icon: Star,
        onSelect: () => void bulkStar(),
      },
    ],
    [
      {
        key: 'bulk-trash',
        label: 'Move to trash',
        icon: Trash2,
        destructive: true,
        disabled: !canTrashSelection(selectedFolders, selectedFiles),
        onSelect: () => setBulkTrashOpen(true),
      },
    ],
  ];

  if (error) return <DriveError error={error} />;

  if (isLoading || !folder) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const pageCount = folders.length + files.length;
  const isEmpty = !children.isLoading && pageCount === 0;

  const rowProps: DriveRowProps = {
    selection,
    bulkGroups: selection.count > 1 ? bulkGroups : undefined,
    dropTargetId,
    onBeginDrag: beginDrag,
    onEndDrag: endDrag,
    onDragOverFolder: dragOverFolder,
    onDropOnFolder: dropOnFolder,
    onDragLeaveFolder: () => setDropTargetId(null),
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DriveBreadcrumbs
          trail={breadcrumbs}
          className="min-w-0 flex-1"
          onDropItems={(targetFolderId, event) => dropOnFolder(event, targetFolderId)}
          canAcceptDrop={canDropOn}
        />

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => folderPicker.current?.click()}
            disabled={!canUploadHere}
            title={canUploadHere ? undefined : 'You do not have permission to upload here'}
          >
            <FolderUp className="mr-2 size-4" aria-hidden="true" />
            Upload folder
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => filePicker.current?.click()}
            disabled={!canUploadHere}
            title={canUploadHere ? undefined : 'You do not have permission to upload here'}
          >
            <UploadCloud className="mr-2 size-4" aria-hidden="true" />
            Upload files
          </Button>
          <Button
            size="sm"
            onClick={() => setNewFolderOpen(true)}
            disabled={!folder.capabilities.canCreateFolder || folder.status !== 'active'}
            title={
              folder.capabilities.canCreateFolder
                ? undefined
                : 'You do not have permission to create folders here'
            }
          >
            <FolderPlus className="mr-2 size-4" aria-hidden="true" />
            New folder
          </Button>
        </div>
      </div>

      {/* Kept out of the visual flow but inside the form-control tree so the labels above
          stay real buttons. `webkitdirectory` is how a browser offers folder upload. */}
      <input
        ref={filePicker}
        type="file"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          startUpload(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <input
        ref={folderPicker}
        type="file"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        // Not in the React DOM typings; both attributes are needed for cross-browser support.
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(event) => {
          startUpload(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <input
        ref={versionPicker}
        type="file"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const selected = event.target.files?.[0];
          const target = versionTarget.current;
          event.target.value = '';
          versionTarget.current = null;
          // The upload waits for the note. Picking the bytes is not the decision — what
          // changed is, and that is the one thing only the person uploading knows.
          if (selected && target) setPendingVersion({ file: target, selected });
        }}
      />

      {selection.count > 0 ? (
        <SelectionBar
          count={selection.count}
          canMove={canMoveSelection(selectedFolders, selectedFiles)}
          canTrash={canTrashSelection(selectedFolders, selectedFiles)}
          isBusy={isBulkRunning}
          onMove={() => setBulkMoveOpen(true)}
          onStar={() => void bulkStar()}
          onTrash={() => setBulkTrashOpen(true)}
          onClear={clearSelection}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Filter this folder by name"
              aria-label="Filter this folder by name"
              className="pl-9"
            />
          </div>

          <Select
            value={`${sort}:${order}`}
            onValueChange={(value) => {
              const [nextSort, nextOrder] = value.split(':') as [ListQuery['sort'], ListQuery['order']];
              setSort(nextSort);
              setOrder(nextOrder);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-48" aria-label="Sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name:asc">Name A–Z</SelectItem>
              <SelectItem value="name:desc">Name Z–A</SelectItem>
              <SelectItem value="updatedAt:desc">Recently modified</SelectItem>
              <SelectItem value="createdAt:desc">Recently created</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex rounded-md border">
            <Button
              variant={view === 'list' ? 'secondary' : 'ghost'}
              size="icon"
              className="size-9 rounded-r-none"
              onClick={() => setView('list')}
              aria-label="List view"
              aria-pressed={view === 'list'}
            >
              <List className="size-4" aria-hidden="true" />
            </Button>
            <Button
              variant={view === 'grid' ? 'secondary' : 'ghost'}
              size="icon"
              className="size-9 rounded-l-none"
              onClick={() => setView('grid')}
              aria-label="Grid view"
              aria-pressed={view === 'grid'}
            >
              <LayoutGrid className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      <UploadDropzone disabled={!canUploadHere} onFiles={startUpload} className="min-h-32 flex-1">
        {children.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : isEmpty ? (
          <EmptyState
            canCreate={folder.capabilities.canCreateFolder && folder.status === 'active'}
            canUpload={canUploadHere}
            isFiltered={search.length > 0}
            onCreate={() => setNewFolderOpen(true)}
            onUpload={() => filePicker.current?.click()}
          />
        ) : view === 'list' ? (
          <ListView
            folders={folders}
            files={files}
            actions={actions}
            fileActions={fileActions}
            onOpen={(id) => router.push(`/drive/${id}`)}
            {...rowProps}
          />
        ) : (
          <GridView
            folders={folders}
            files={files}
            actions={actions}
            fileActions={fileActions}
            onOpen={(id) => router.push(`/drive/${id}`)}
            {...rowProps}
          />
        )}
      </UploadDropzone>

      {pageCount >= PAGE_SIZE || page > 1 ? (
        <div className="flex items-center justify-between border-t pt-3 text-sm">
          <span className="text-muted-foreground">Page {page}</span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pageCount < PAGE_SIZE}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      <NewFolderDialog
        parentFolderId={folder.id}
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
      />
      <RenameFolderDialog folder={renaming} onOpenChange={() => setRenaming(null)} />
      <FolderDetailsPanel folder={detailsFor} onOpenChange={() => setDetailsFor(null)} />

      <ShareDialog
        targetType="folder"
        targetId={sharingFolder?.id ?? null}
        targetName={sharingFolder?.name ?? ''}
        open={sharingFolder !== null}
        onOpenChange={(open) => !open && setSharingFolder(null)}
      />
      <ShareDialog
        targetType="file"
        targetId={sharingFile?.id ?? null}
        targetName={sharingFile?.displayName ?? ''}
        open={sharingFile !== null}
        onOpenChange={(open) => !open && setSharingFile(null)}
      />

      <RenameFileDialog file={renamingFile} onOpenChange={() => setRenamingFile(null)} />
      <FileDetailsPanel file={fileDetailsFor} onOpenChange={() => setFileDetailsFor(null)} />
      <FilePreviewDialog file={previewing} onOpenChange={() => setPreviewing(null)} />

      <FolderPickerDialog
        open={movingFile !== null}
        onOpenChange={() => setMovingFile(null)}
        title={`Move "${movingFile?.displayName ?? ''}"`}
        description="The file keeps its version history and moves to the destination's department and project."
        confirmLabel="Move here"
        initialFolderId={folder.id}
        isPending={moveFile.isPending}
        onConfirm={async (targetFolderId) => {
          if (!movingFile) return;
          const okResult = await run(
            moveFile.mutateAsync({ fileId: movingFile.id, targetFolderId }),
            `Moved "${movingFile.displayName}"`,
            'Could not move the file',
          );
          if (okResult) setMovingFile(null);
        }}
      />

      <FolderPickerDialog
        open={copyingFile !== null}
        onOpenChange={() => setCopyingFile(null)}
        title={`Copy "${copyingFile?.displayName ?? ''}"`}
        description="The copy starts a fresh history at version 1 and takes the access rules of its new location."
        confirmLabel="Copy here"
        initialFolderId={folder.id}
        isPending={copyFile.isPending}
        onConfirm={async (targetFolderId) => {
          if (!copyingFile) return;
          const okResult = await run(
            copyFile.mutateAsync({ fileId: copyingFile.id, targetFolderId }),
            `Copied "${copyingFile.displayName}"`,
            'Could not copy the file',
          );
          if (okResult) setCopyingFile(null);
        }}
      />

      <FolderPickerDialog
        open={bulkMoveOpen}
        onOpenChange={() => setBulkMoveOpen(false)}
        title={`Move ${selection.count} item${selection.count === 1 ? '' : 's'}`}
        description="Everything selected moves together, and takes the access rules of where it lands."
        confirmLabel="Move here"
        initialFolderId={folder.id}
        isPending={isBulkRunning}
        onConfirm={async (targetFolderId) => {
          await moveItems(targetFolderId, selectedFolders, selectedFiles);
          setBulkMoveOpen(false);
        }}
      />

      <AlertDialog open={bulkTrashOpen} onOpenChange={setBulkTrashOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Move {selection.count} item{selection.count === 1 ? '' : 's'} to trash?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedFolders.length > 0
                ? 'Everything inside the selected folders goes to the trash too. '
                : ''}
              You can restore from Trash until the retention period ends, after which it is
              permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={isBulkRunning} onClick={() => void bulkTrash()}>
              Move to trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <NewVersionDialog
        pending={pendingVersion}
        onCancel={() => setPendingVersion(null)}
        onConfirm={(note) => {
          if (!pendingVersion) return;
          uploader.enqueue([pendingVersion.selected], {
            folderId: pendingVersion.file.folderId,
            targetFileId: pendingVersion.file.id,
            ...(note ? { versionNote: note } : {}),
          });
          setPendingVersion(null);
        }}
      />

      <FolderPickerDialog
        open={moving !== null}
        onOpenChange={() => setMoving(null)}
        title={`Move "${moving?.name ?? ''}"`}
        description="Choose where this folder and everything inside it should go."
        confirmLabel="Move here"
        excludeSubtreeOf={moving}
        initialFolderId={folder.id}
        isPending={move.isPending}
        onConfirm={async (targetParentFolderId) => {
          if (!moving) return;
          const okResult = await run(
            move.mutateAsync({ folderId: moving.id, targetParentFolderId }),
            `Moved "${moving.name}"`,
            'Could not move the folder',
          );
          if (okResult) setMoving(null);
        }}
      />

      <FolderPickerDialog
        open={copying !== null}
        onOpenChange={() => setCopying(null)}
        title={`Copy "${copying?.name ?? ''}"`}
        description="The copy takes the access rules of its new location, not the original's."
        confirmLabel="Copy here"
        excludeSubtreeOf={copying}
        initialFolderId={folder.id}
        isPending={copy.isPending}
        onConfirm={async (targetParentFolderId) => {
          if (!copying) return;
          const okResult = await run(
            copy.mutateAsync({ folderId: copying.id, targetParentFolderId }),
            `Copied "${copying.name}"`,
            'Could not copy the folder',
          );
          if (okResult) setCopying(null);
        }}
      />

      <AlertDialog open={trashing !== null} onOpenChange={() => setTrashing(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move &ldquo;{trashing?.name}&rdquo; to trash?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything inside it goes to the trash too. You can restore it from Trash until the
              retention period ends, after which it is permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!trashing) return;
                await trashOneFolder(trashing);
                setTrashing(null);
              }}
            >
              Move to trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Everything the two views need in order to select, drag and right-click a row. */
interface DriveRowProps {
  selection: Selection;
  bulkGroups?: ActionGroup[];
  dropTargetId: string | null;
  onBeginDrag: (event: React.DragEvent, key: string) => void;
  onEndDrag: () => void;
  onDragOverFolder: (event: React.DragEvent, folderId: string) => void;
  onDropOnFolder: (event: React.DragEvent, folderId: string) => void;
  onDragLeaveFolder: () => void;
}

interface ViewProps extends DriveRowProps {
  folders: FolderDto[];
  files: FileDto[];
  actions: FolderActions;
  fileActions: FileActions;
  onOpen: (id: string) => void;
}

function ListView({
  folders,
  files,
  actions,
  fileActions,
  onOpen,
  selection,
  bulkGroups,
  dropTargetId,
  onBeginDrag,
  onEndDrag,
  onDragOverFolder,
  onDropOnFolder,
  onDragLeaveFolder,
}: ViewProps) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={selection.allSelected}
                indeterminate={selection.someSelected}
                onChange={(event) => (event.target.checked ? selection.selectAll() : selection.clear())}
                aria-label="Select everything on this page"
              />
            </TableHead>
            <TableHead>Name</TableHead>
            <TableHead className="hidden w-40 sm:table-cell">Modified</TableHead>
            <TableHead className="hidden w-32 md:table-cell">Size</TableHead>
            <TableHead className="w-12" aria-label="Actions" />
          </TableRow>
        </TableHeader>
        {/* Folders first, then files — the order every drive uses. */}
        <TableBody>
          {folders.map((folder) => {
            const key = itemKey('folder', folder.id);
            const isSelected = selection.has(key);

            return (
              <DriveContextMenu
                key={key}
                groups={folderActionGroups(folder, actions)}
                {...(bulkGroups && isSelected ? { bulk: { count: selection.count, groups: bulkGroups } } : {})}
              >
                <TableRow
                  tabIndex={0}
                  data-state={isSelected ? 'selected' : undefined}
                  draggable
                  onDragStart={(event) => onBeginDrag(event, key)}
                  onDragEnd={onEndDrag}
                  onDragOver={(event) => onDragOverFolder(event, folder.id)}
                  onDragLeave={onDragLeaveFolder}
                  onDrop={(event) => onDropOnFolder(event, folder.id)}
                  onDoubleClick={() => onOpen(folder.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onOpen(folder.id);
                  }}
                  className={cn(
                    'cursor-pointer',
                    dropTargetId === folder.id && 'bg-primary/10 outline outline-2 outline-primary',
                  )}
                >
                  <TableCell>
                    <Checkbox
                      checked={isSelected}
                      onChange={(event) => selection.set(key, event.target.checked)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`Select ${folder.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={(event) => {
                        // ⌘/Ctrl and Shift are selection gestures everywhere else; opening
                        // the folder instead would make range-selecting impossible.
                        if (event.metaKey || event.ctrlKey || event.shiftKey) {
                          event.preventDefault();
                          selection.toggle(key, { meta: event.metaKey || event.ctrlKey, shift: event.shiftKey });
                          return;
                        }
                        onOpen(folder.id);
                      }}
                      className="flex min-w-0 items-center gap-2 text-left hover:underline"
                    >
                      <FolderClosed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="truncate font-medium">{folder.name}</span>
                      {folder.isStarred ? (
                        <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />
                      ) : null}
                      {!folder.inheritPermissions ? (
                        <Lock
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-label="Restricted access"
                        />
                      ) : null}
                    </button>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {formatRelativeTime(folder.updatedAt)}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {describeContents(folder)}
                  </TableCell>
                  <TableCell>
                    <FolderActionsMenu folder={folder} actions={actions} />
                  </TableCell>
                </TableRow>
              </DriveContextMenu>
            );
          })}

          {files.map((file) => {
            const key = itemKey('file', file.id);
            const isSelected = selection.has(key);
            const open = () =>
              file.previewable && file.capabilities.canPreview
                ? fileActions.onPreview(file)
                : fileActions.onDetails(file);

            return (
              <DriveContextMenu
                key={key}
                groups={fileActionGroups(file, fileActions)}
                {...(bulkGroups && isSelected ? { bulk: { count: selection.count, groups: bulkGroups } } : {})}
              >
                <TableRow
                  tabIndex={0}
                  data-state={isSelected ? 'selected' : undefined}
                  draggable
                  onDragStart={(event) => onBeginDrag(event, key)}
                  onDragEnd={onEndDrag}
                  onDoubleClick={open}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') open();
                  }}
                  className="cursor-pointer"
                >
                  <TableCell>
                    <Checkbox
                      checked={isSelected}
                      onChange={(event) => selection.set(key, event.target.checked)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`Select ${file.displayName}`}
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey) {
                          event.preventDefault();
                          selection.toggle(key, { meta: event.metaKey || event.ctrlKey, shift: event.shiftKey });
                          return;
                        }
                        open();
                      }}
                      className="flex min-w-0 items-center gap-2 text-left hover:underline"
                    >
                      <FileIcon category={file.category} className="size-4" />
                      <span className="truncate font-medium">{file.displayName}</span>
                      {file.isStarred ? (
                        <Star
                          className="size-3.5 shrink-0 fill-amber-400 text-amber-400"
                          aria-label="Starred"
                        />
                      ) : null}
                      {file.approvalStatus === 'approved' ? (
                        <Badge className="shrink-0 bg-emerald-600 text-[10px] hover:bg-emerald-600">
                          Approved
                        </Badge>
                      ) : null}
                      {file.versionCount > 1 ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          v{file.versionCount}
                        </span>
                      ) : null}
                      {!file.inheritPermissions ? (
                        <Lock
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-label="Restricted access"
                        />
                      ) : null}
                    </button>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {formatRelativeTime(file.updatedAt)}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {formatBytes(file.sizeBytes)}
                  </TableCell>
                  <TableCell>
                    <FileActionsMenu file={file} actions={fileActions} />
                  </TableCell>
                </TableRow>
              </DriveContextMenu>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function GridView({
  folders,
  files,
  actions,
  fileActions,
  onOpen,
  selection,
  bulkGroups,
  dropTargetId,
  onBeginDrag,
  onEndDrag,
  onDragOverFolder,
  onDropOnFolder,
  onDragLeaveFolder,
}: ViewProps) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {folders.map((folder) => {
        const key = itemKey('folder', folder.id);
        const isSelected = selection.has(key);

        return (
          <li key={key}>
            <DriveContextMenu
              groups={folderActionGroups(folder, actions)}
              {...(bulkGroups && isSelected ? { bulk: { count: selection.count, groups: bulkGroups } } : {})}
            >
              <div
                draggable
                onDragStart={(event) => onBeginDrag(event, key)}
                onDragEnd={onEndDrag}
                onDragOver={(event) => onDragOverFolder(event, folder.id)}
                onDragLeave={onDragLeaveFolder}
                onDrop={(event) => onDropOnFolder(event, folder.id)}
                className={cn(
                  'group flex items-start gap-2 rounded-md border p-3 transition-colors hover:border-primary/50 hover:bg-muted/50',
                  isSelected && 'border-primary bg-primary/5',
                  dropTargetId === folder.id && 'border-primary bg-primary/10 outline outline-2 outline-primary',
                )}
              >
                <Checkbox
                  checked={isSelected}
                  onChange={(event) => selection.set(key, event.target.checked)}
                  className="mt-1"
                  aria-label={`Select ${folder.name}`}
                />
                <button
                  type="button"
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey) {
                      event.preventDefault();
                      selection.toggle(key, { meta: event.metaKey || event.ctrlKey, shift: event.shiftKey });
                      return;
                    }
                    onOpen(folder.id);
                  }}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-2">
                    <FolderClosed className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate font-medium">{folder.name}</span>
                    {folder.isStarred ? (
                      <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />
                    ) : null}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{describeContents(folder)}</p>
                  <p className="text-xs text-muted-foreground">
                    Modified {formatRelativeTime(folder.updatedAt)}
                  </p>
                </button>
                <FolderActionsMenu folder={folder} actions={actions} />
              </div>
            </DriveContextMenu>
          </li>
        );
      })}

      {files.map((file) => {
        const key = itemKey('file', file.id);
        const isSelected = selection.has(key);

        return (
          <li key={key}>
            <DriveContextMenu
              groups={fileActionGroups(file, fileActions)}
              {...(bulkGroups && isSelected ? { bulk: { count: selection.count, groups: bulkGroups } } : {})}
            >
              <div
                draggable
                onDragStart={(event) => onBeginDrag(event, key)}
                onDragEnd={onEndDrag}
                className={cn(
                  'group flex items-start gap-2 rounded-md border p-3 transition-colors hover:border-primary/50 hover:bg-muted/50',
                  isSelected && 'border-primary bg-primary/5',
                )}
              >
                <Checkbox
                  checked={isSelected}
                  onChange={(event) => selection.set(key, event.target.checked)}
                  className="mt-1"
                  aria-label={`Select ${file.displayName}`}
                />
                <button
                  type="button"
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey) {
                      event.preventDefault();
                      selection.toggle(key, { meta: event.metaKey || event.ctrlKey, shift: event.shiftKey });
                      return;
                    }
                    if (file.previewable && file.capabilities.canPreview) fileActions.onPreview(file);
                    else fileActions.onDetails(file);
                  }}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-2">
                    <FileIcon category={file.category} className="size-5" />
                    <span className="truncate font-medium">{file.displayName}</span>
                    {file.isStarred ? (
                      <Star
                        className="size-3.5 shrink-0 fill-amber-400 text-amber-400"
                        aria-label="Starred"
                      />
                    ) : null}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {formatBytes(file.sizeBytes)}
                    {file.versionCount > 1 ? ` · ${file.versionCount} versions` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Modified {formatRelativeTime(file.updatedAt)}
                  </p>
                </button>
                <FileActionsMenu file={file} actions={fileActions} />
              </div>
            </DriveContextMenu>
          </li>
        );
      })}
    </ul>
  );
}

/** A bulk action is offered only when at least one selected item would accept it. */
function canMoveSelection(selectedFolders: FolderDto[], selectedFiles: FileDto[]): boolean {
  return (
    selectedFolders.some((entry) => entry.capabilities.canMove) ||
    selectedFiles.some((entry) => entry.capabilities.canMove)
  );
}

function canTrashSelection(selectedFolders: FolderDto[], selectedFiles: FileDto[]): boolean {
  return (
    selectedFolders.some((entry) => entry.capabilities.canDelete) ||
    selectedFiles.some((entry) => entry.capabilities.canDelete)
  );
}

/** Keyboard shortcuts must never fire while somebody is typing a filename. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
  );
}

/**
 * Nor while a dialog owns the screen.
 *
 * `alertdialog` is included because the trash confirmation is one: without it, Escape
 * would close the confirmation *and* wipe the selection the user was about to act on.
 */
function isDialogOpen(): boolean {
  return (
    document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !==
    null
  );
}

function describeContents(folder: FolderDto): string {
  const parts: string[] = [];
  if (folder.childFolderCount > 0) {
    parts.push(`${folder.childFolderCount} folder${folder.childFolderCount === 1 ? '' : 's'}`);
  }
  if (folder.fileCount > 0) {
    parts.push(`${folder.fileCount} file${folder.fileCount === 1 ? '' : 's'}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'Empty';
}

function EmptyState({
  canCreate,
  canUpload,
  isFiltered,
  onCreate,
  onUpload,
}: {
  canCreate: boolean;
  canUpload: boolean;
  isFiltered: boolean;
  onCreate: () => void;
  onUpload: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed p-12 text-center">
      <FolderClosed className="size-10 text-muted-foreground" aria-hidden="true" />
      <p className="mt-4 font-medium">{isFiltered ? 'No matches' : 'This folder is empty'}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {isFiltered
          ? 'Nothing here starts with what you typed. Try a shorter filter.'
          : canUpload
            ? 'Drop files here, or create a folder to start organizing research data.'
            : 'Create a folder to start organizing research data.'}
      </p>
      {!isFiltered ? (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {canUpload ? (
            <Button size="sm" onClick={onUpload}>
              <UploadCloud className="mr-2 size-4" aria-hidden="true" />
              Upload files
            </Button>
          ) : null}
          {canCreate ? (
            <Button size="sm" variant="outline" onClick={onCreate}>
              <FolderPlus className="mr-2 size-4" aria-hidden="true" />
              New folder
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A 404 here usually means "you cannot see this", not "this does not exist" — the API
 * deliberately does not distinguish the two, so neither does this message.
 */
export function DriveError({ error }: { error: unknown }) {
  const status = error instanceof ApiError ? error.status : 0;
  const title =
    status === 404
      ? 'Not found, or not shared with you'
      : status === 403
        ? 'You do not have access to this folder'
        : 'Something went wrong';
  const detail =
    status === 404 || status === 403
      ? 'Ask the folder owner or your department head to share it with you.'
      : error instanceof ApiError
        ? error.message
        : 'Try again in a moment.';

  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed p-12 text-center">
      <AlertTriangle className="size-10 text-muted-foreground" aria-hidden="true" />
      <p className="mt-4 font-medium">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{detail}</p>
      {error instanceof ApiError && error.requestId ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Reference: <code className="rounded bg-muted px-1.5 py-0.5">{error.requestId}</code>
        </p>
      ) : null}
    </div>
  );
}
