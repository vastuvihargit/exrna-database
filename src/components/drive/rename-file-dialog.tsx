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
import { useRenameFile, type FileDto } from '@/hooks/use-files';

export function RenameFileDialog({
  file,
  onOpenChange,
}: {
  file: FileDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('');
  const rename = useRenameFile();

  useEffect(() => {
    if (file) setName(file.displayName);
  }, [file]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) return;
    try {
      await rename.mutateAsync({ fileId: file.id, name: name.trim() });
      toast.success('Renamed');
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not rename the file');
    }
  };

  return (
    <Dialog open={file !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Rename file</DialogTitle>
            <DialogDescription>
              The display name changes; every stored version keeps the filename it was
              uploaded with.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-4">
            <Label htmlFor="rename-file">Name</Label>
            <Input
              id="rename-file"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={300}
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
              disabled={rename.isPending || name.trim().length === 0 || name === file?.displayName}
            >
              {rename.isPending ? 'Renaming…' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
