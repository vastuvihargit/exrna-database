'use client';

import { useState } from 'react';
import { RotateCcw, StarOff } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import {
  useArchive,
  useArchiveFolder,
  useRecent,
  useRestoreFolder,
  useStarFolder,
  useStarred,
  useTrash,
} from '@/hooks/use-drive';
import { useRestoreFile, useStarFile, type FileDto } from '@/hooks/use-files';
import { DriveItemCollection } from './drive-item-collection';
import { FileDetailsPanel } from './file-details-panel';

/** Shared by every view here: report the server's own message, never a generic one. */
function reportFailure(error: unknown, fallback: string) {
  toast.error(error instanceof ApiError ? error.message : fallback);
}

export function RecentView() {
  const recent = useRecent();
  const [selected, setSelected] = useState<FileDto | null>(null);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Recent</h1>
        <p className="mt-1 text-muted-foreground">
          Files and folders you opened most recently, newest first.
        </p>
      </header>

      <DriveItemCollection
        folders={recent.data?.folders}
        files={recent.data?.files}
        isLoading={recent.isLoading}
        error={recent.error}
        emptyTitle="Nothing here yet"
        emptyDescription="Files and folders you open appear here so you can get back to them quickly."
        onOpenFile={setSelected}
      />

      <FileDetailsPanel file={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}

export function StarredView() {
  const starred = useStarred();
  const starFolder = useStarFolder();
  const starFile = useStarFile();
  const [selected, setSelected] = useState<FileDto | null>(null);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Starred</h1>
        <p className="mt-1 text-muted-foreground">
          Your own shortcuts. Starring is private — nobody else sees what you have starred.
        </p>
      </header>

      <DriveItemCollection
        folders={starred.data?.folders}
        files={starred.data?.files}
        isLoading={starred.isLoading}
        error={starred.error}
        emptyTitle="No starred items"
        emptyDescription="Star a file or folder from its actions menu to pin it here."
        onOpenFile={setSelected}
        // Unstarring belongs on this page: it is the only place someone goes looking to
        // undo a star, and sending them back to the original folder to do it is a dead end.
        renderFolderAction={(folder) => (
          <Button
            variant="ghost"
            size="sm"
            disabled={starFolder.isPending}
            onClick={async () => {
              try {
                await starFolder.mutateAsync({ folderId: folder.id, starred: false });
                toast.success(`Removed the star from "${folder.name}"`);
              } catch (error) {
                reportFailure(error, 'Could not remove the star');
              }
            }}
          >
            <StarOff className="mr-2 size-4" aria-hidden="true" />
            Remove star
          </Button>
        )}
        renderFileAction={(file) => (
          <Button
            variant="ghost"
            size="sm"
            disabled={starFile.isPending}
            onClick={async () => {
              try {
                await starFile.mutateAsync({ fileId: file.id, starred: false });
                toast.success(`Removed the star from "${file.displayName}"`);
              } catch (error) {
                reportFailure(error, 'Could not remove the star');
              }
            }}
          >
            <StarOff className="mr-2 size-4" aria-hidden="true" />
            Remove star
          </Button>
        )}
      />

      <FileDetailsPanel file={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}

export function ArchiveView() {
  const [page] = useState(1);
  const archive = useArchive(page);
  const unarchive = useArchiveFolder();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Archive</h1>
        <p className="mt-1 text-muted-foreground">
          Completed work, out of the way but still readable and searchable. Archiving deletes
          nothing.
        </p>
      </header>

      <DriveItemCollection
        folders={archive.data?.folders}
        files={archive.data?.files}
        isLoading={archive.isLoading}
        error={archive.error}
        emptyTitle="Nothing archived"
        emptyDescription="Archive a folder when a study is finished but its data must stay available."
        renderFolderAction={(folder) => (
          <Button
            variant="outline"
            size="sm"
            disabled={unarchive.isPending || !folder.capabilities.canRestore}
            onClick={async () => {
              try {
                await unarchive.mutateAsync({ folderId: folder.id, archived: false });
                toast.success(`Restored "${folder.name}"`);
              } catch (error) {
                reportFailure(error, 'Could not unarchive the folder');
              }
            }}
          >
            <RotateCcw className="mr-2 size-4" aria-hidden="true" />
            Unarchive
          </Button>
        )}
      />
    </div>
  );
}

export function TrashView() {
  const [page] = useState(1);
  const trash = useTrash(page);
  const restoreFolder = useRestoreFolder();
  const restoreFile = useRestoreFile();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Trash</h1>
        <p className="mt-1 text-muted-foreground">
          Deleted files and folders stay here until the retention period ends, then they are
          permanently removed.
        </p>
      </header>

      <DriveItemCollection
        folders={trash.data?.folders}
        files={trash.data?.files}
        isLoading={trash.isLoading}
        error={trash.error}
        emptyTitle="Trash is empty"
        emptyDescription="Files and folders you delete land here first, together with everything inside them."
        renderFolderAction={(folder) => (
          <Button
            variant="outline"
            size="sm"
            disabled={restoreFolder.isPending}
            onClick={async () => {
              try {
                await restoreFolder.mutateAsync(folder.id);
                toast.success(`Restored "${folder.name}"`);
              } catch (error) {
                reportFailure(error, 'Could not restore the folder');
              }
            }}
          >
            <RotateCcw className="mr-2 size-4" aria-hidden="true" />
            Restore
          </Button>
        )}
        renderFileAction={(file) => (
          <Button
            variant="outline"
            size="sm"
            disabled={restoreFile.isPending}
            onClick={async () => {
              try {
                await restoreFile.mutateAsync(file.id);
                toast.success(`Restored "${file.displayName}"`, {
                  description: 'It is back in the folder it was deleted from.',
                });
              } catch (error) {
                reportFailure(error, 'Could not restore the file');
              }
            }}
          >
            <RotateCcw className="mr-2 size-4" aria-hidden="true" />
            Restore
          </Button>
        )}
      />
    </div>
  );
}
