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
import { useCreateFolder } from '@/hooks/use-drive';

export function NewFolderDialog({
  parentFolderId,
  open,
  onOpenChange,
}: {
  parentFolderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('Untitled folder');
  const createFolder = useCreateFolder();

  // Reset on each open so a failed attempt does not leave a stale value behind.
  useEffect(() => {
    if (open) setName('Untitled folder');
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const folder = await createFolder.mutateAsync({ name: name.trim(), parentFolderId });
      toast.success(`Created "${folder.name}"`);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not create the folder');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Folder names must be unique inside this folder, so nothing is filed twice.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-4">
            <Label htmlFor="folder-name">Name</Label>
            <Input
              id="folder-name"
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
            <Button type="submit" disabled={createFolder.isPending || name.trim().length === 0}>
              {createFolder.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
