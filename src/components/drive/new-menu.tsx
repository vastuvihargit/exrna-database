'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, FolderPlus, FolderUp, Plus, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useUploadContext } from '@/components/providers/upload-provider';
import { useResolveUploadTarget } from '@/hooks/use-upload';
import { requestNewFolder, resolveOpenFolderTarget } from './drive-intents';

/**
 * The one button that creates things, wherever the user happens to be.
 *
 * Before this existed, uploading was only possible from inside an open folder: the
 * sidebar offered "New folder" alone, so somebody sitting on Home, Recent or a search
 * result had no way to add a file without first working out which folder to open. That
 * is backwards — deciding where a file belongs is the part people find hard, and it is
 * the part a drive should be able to answer for them.
 *
 * So: files go to the folder on screen if there is one, and to My Drive if there is not,
 * and the toast says which, because silently filing somebody's data somewhere they did
 * not choose is worse than an extra sentence.
 */
export function NewMenu({
  className,
  onAction,
}: {
  className?: string;
  /** Lets the mobile navigation sheet close itself once something has been chosen. */
  onAction?: () => void;
}) {
  const router = useRouter();
  const uploader = useUploadContext();
  const resolveTarget = useResolveUploadTarget();

  const filePicker = React.useRef<HTMLInputElement>(null);
  const folderPicker = React.useRef<HTMLInputElement>(null);

  const send = React.useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const openFolderId = resolveOpenFolderTarget();
      if (openFolderId) {
        uploader.enqueue(files, { folderId: openFolderId });
        return;
      }

      try {
        const target = await resolveTarget();
        uploader.enqueue(files, { folderId: target.folder.id });
        toast.success(
          `Uploading ${files.length} file${files.length === 1 ? '' : 's'} to ${target.folder.name}`,
          { description: 'You were not in a folder, so these went to your own drive.' },
        );
        router.push('/my-drive');
      } catch {
        toast.error('Could not work out where to put these files', {
          description: 'Open the folder you want them in and try again.',
        });
      }
    },
    [resolveTarget, router, uploader],
  );

  const newFolder = () => {
    onAction?.();
    // An open folder view creates the folder where the user is looking. Nothing claims
    // it elsewhere, so send them to the drive that is always theirs to write to.
    if (!requestNewFolder()) router.push('/my-drive');
  };

  /**
   * Opens a file picker from a menu item.
   *
   * Deferred by a tick because the menu closes and restores focus to its trigger during
   * `onSelect`, which can swallow a picker opened synchronously in the same task. A zero
   * timeout still runs inside the browser's transient activation window, so the picker is
   * allowed to open.
   */
  const openPicker = (picker: React.RefObject<HTMLInputElement | null>) => {
    onAction?.();
    setTimeout(() => picker.current?.click(), 0);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button className={className}>
            <Plus className="mr-2 size-4" aria-hidden="true" />
            New
            <ChevronDown className="ml-auto size-4 opacity-70" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onSelect={() => openPicker(filePicker)}>
            <UploadCloud className="mr-2 size-4" aria-hidden="true" /> Upload files
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openPicker(folderPicker)}>
            <FolderUp className="mr-2 size-4" aria-hidden="true" /> Upload a folder
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={newFolder}>
            <FolderPlus className="mr-2 size-4" aria-hidden="true" /> New folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Kept out of the layout but in the control tree, so the menu items above stay
          real buttons. `webkitdirectory` is how a browser offers whole-folder upload. */}
      <input
        ref={filePicker}
        type="file"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          void send(Array.from(event.target.files ?? []));
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
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(event) => {
          void send(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
    </>
  );
}
