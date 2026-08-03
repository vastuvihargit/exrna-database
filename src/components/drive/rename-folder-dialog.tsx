'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api-client';
import { useRenameFolder, type FolderDto } from '@/hooks/use-drive';

export function RenameFolderDialog({
  folder,
  onOpenChange,
}: {
  folder: FolderDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('');
  const rename = useRenameFolder();

  useEffect(() => {
    if (folder) setName(folder.name);
  }, [folder]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!folder) return;
    try {
      await rename.mutateAsync({ folderId: folder.id, name: name.trim() });
      toast.success('Renamed');
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not rename the folder');
    }
  };

  return (
    <Dialog open={folder !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
            <DialogDescription>
              Renaming does not move anything — links and history stay intact.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-4">
            <Label htmlFor="rename-folder">Name</Label>
            <Input
              id="rename-folder"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              required
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={rename.isPending || name.trim().length === 0 || name === folder?.name}
            >
              {rename.isPending ? 'Renaming…' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
