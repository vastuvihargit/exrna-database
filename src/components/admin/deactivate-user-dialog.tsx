'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';

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
import { useSetUserStatus, type AdminUser } from '@/hooks/use-admin';

/**
 * Deactivation requires a written reason — it is stored on the audit record, and the
 * server rejects the request without one.
 */
export function DeactivateUserDialog({
  user,
  open,
  onOpenChange,
}: {
  user: AdminUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const setStatus = useSetUserStatus();

  React.useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);

  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Deactivate {user.name}?</DialogTitle>
          <DialogDescription>
            They will lose access immediately — every active session is revoked and the next request
            from any device is rejected. Their files and history are preserved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="deactivate-reason">Reason (recorded in the audit log)</Label>
          <Input
            id="deactivate-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Left the company"
          />
        </div>

        {error ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim().length < 3 || setStatus.isPending}
            onClick={() => {
              setError(null);
              setStatus.mutate(
                { userId: user.id, status: 'deactivated', reason: reason.trim() },
                {
                  onSuccess: () => onOpenChange(false),
                  onError: (err: unknown) =>
                    setError(err instanceof ApiError ? err.message : 'Could not deactivate the account.'),
                },
              );
            }}
          >
            {setStatus.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Deactivate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
