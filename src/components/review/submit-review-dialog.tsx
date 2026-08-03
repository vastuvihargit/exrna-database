'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, User as UserIcon, X } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError, apiRequest } from '@/lib/api-client';
import type { FileDto } from '@/hooks/use-files';
import { useSubmitForReview } from '@/hooks/use-reviews';

interface DirectoryEntry {
  id: string;
  email: string;
  name: string;
}

/**
 * Submits the file's *current* version for review.
 *
 * The dialog says which version explicitly, because that is what the reviewer signs. It
 * refuses to let the submitter name themselves — the server enforces the same rule, and
 * so does the owner check on the decision side.
 */
export function SubmitReviewDialog({
  file,
  open,
  onOpenChange,
}: {
  file: FileDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const submit = useSubmitForReview();

  const [search, setSearch] = React.useState('');
  const [reviewers, setReviewers] = React.useState<DirectoryEntry[]>([]);
  const [note, setNote] = React.useState('');
  const [requiredApprovals, setRequiredApprovals] = React.useState(1);

  const directory = useQuery({
    queryKey: ['directory', search] as const,
    queryFn: () =>
      apiRequest<DirectoryEntry[]>(`/api/users?search=${encodeURIComponent(search)}&pageSize=8`),
    enabled: open && search.trim().length >= 2,
  });

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      setReviewers([]);
      setNote('');
      setRequiredApprovals(1);
    }
  }, [open]);

  const add = (person: DirectoryEntry) => {
    if (reviewers.some((reviewer) => reviewer.id === person.id)) return;
    setReviewers((current) => [...current, person]);
    setSearch('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Submit for review</DialogTitle>
          <DialogDescription>
            Version {file.versionCount} of “{file.displayName}” will be sent for sign-off. The
            reviewers approve these exact bytes — a later upload will not inherit the approval.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="review-search">Reviewers</Label>

            {reviewers.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {reviewers.map((reviewer) => (
                  <Badge key={reviewer.id} variant="secondary" className="gap-1 pr-1">
                    {reviewer.name}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-4"
                      aria-label={`Remove ${reviewer.name}`}
                      onClick={() =>
                        setReviewers((current) => current.filter((entry) => entry.id !== reviewer.id))
                      }
                    >
                      <X className="size-3" aria-hidden="true" />
                    </Button>
                  </Badge>
                ))}
              </div>
            ) : null}

            <Input
              id="review-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name or company email"
              autoComplete="off"
            />

            {search.trim().length >= 2 && directory.data ? (
              <ul className="max-h-40 overflow-y-auto rounded-md border">
                {directory.data.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-muted-foreground">No match.</li>
                ) : (
                  directory.data.map((person) => (
                    <li key={person.id}>
                      <button
                        type="button"
                        onClick={() => add(person)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                      >
                        <UserIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">
                          {person.name}
                          <span className="ml-1.5 text-xs text-muted-foreground">{person.email}</span>
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            ) : null}
          </div>

          {reviewers.length > 1 ? (
            <div className="space-y-1.5">
              <Label htmlFor="required-approvals">Approvals needed</Label>
              <Input
                id="required-approvals"
                type="number"
                min={1}
                max={reviewers.length}
                value={requiredApprovals}
                onChange={(event) =>
                  setRequiredApprovals(
                    Math.min(Math.max(1, Number(event.target.value) || 1), reviewers.length),
                  )
                }
              />
              <p className="text-[11px] text-muted-foreground">
                The request stays open until this many reviewers approve. One rejection closes it
                immediately.
              </p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="review-note">Note for the reviewers</Label>
            <textarea
              id="review-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder="What should they be looking at?"
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <Button
            className="w-full"
            disabled={submit.isPending || reviewers.length === 0}
            onClick={async () => {
              try {
                await submit.mutateAsync({
                  fileId: file.id,
                  reviewerUserIds: reviewers.map((reviewer) => reviewer.id),
                  ...(note.trim() ? { note: note.trim() } : {}),
                  ...(requiredApprovals > 1 ? { requiredApprovals } : {}),
                });
                toast.success('Sent for review');
                onOpenChange(false);
              } catch (error) {
                toast.error(
                  error instanceof ApiError ? error.message : 'Could not submit for review',
                );
              }
            }}
          >
            {submit.isPending ? (
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
            ) : null}
            Send for review
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
