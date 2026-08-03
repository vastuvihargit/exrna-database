'use client';

import * as React from 'react';
import { CheckCircle2, Clock, Loader2, ShieldCheck, ThumbsDown, ThumbsUp, XCircle } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/utils';
import {
  useCancelReview,
  useDecideReview,
  useReviews,
  type ReviewDecision,
  type ReviewDto,
} from '@/hooks/use-reviews';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting decision',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Withdrawn',
};

export function ReviewDashboard() {
  const [scope, setScope] = React.useState<'assigned' | 'submitted'>('assigned');
  const reviews = useReviews(scope);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
        <p className="mt-1 text-muted-foreground">
          Every review is of one exact version. Approving records the checksum of the bytes you
          signed, so a later upload can never inherit your approval.
        </p>
      </header>

      <div className="flex gap-1 rounded-lg border p-1" role="tablist">
        <TabButton active={scope === 'assigned'} onClick={() => setScope('assigned')}>
          Waiting on me
        </TabButton>
        <TabButton active={scope === 'submitted'} onClick={() => setScope('submitted')}>
          My submissions
        </TabButton>
      </div>

      {reviews.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-32 w-full" />
          ))}
        </div>
      ) : reviews.error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          {reviews.error instanceof ApiError ? reviews.error.message : 'Could not load reviews.'}
        </p>
      ) : (reviews.data ?? []).length === 0 ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed py-16 text-center">
          <ShieldCheck className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">
            {scope === 'assigned' ? 'Nothing waiting on you' : 'You have not submitted anything'}
          </p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {scope === 'assigned'
              ? 'When a colleague asks you to review a file, it appears here.'
              : 'Open a file and use “Submit for review” to have a colleague sign off on a version.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {(reviews.data ?? []).map((review) => (
            <ReviewCard key={review.id} review={review} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${
        active ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
      }`}
    >
      {children}
    </button>
  );
}

function ReviewCard({ review }: { review: ReviewDto }) {
  const decide = useDecideReview();
  const cancel = useCancelReview();
  const [comment, setComment] = React.useState('');
  const [pendingDecision, setPendingDecision] = React.useState<ReviewDecision | null>(null);

  const submit = async (decision: ReviewDecision) => {
    // A rejection with no reason is unanswerable — the submitter cannot act on it and the
    // audit record explains nothing. The server enforces this too.
    if (decision !== 'approve' && !comment.trim()) {
      setPendingDecision(decision);
      toast.error('Explain what needs to change before rejecting or requesting changes');
      return;
    }
    try {
      await decide.mutateAsync({
        reviewId: review.id,
        decision,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      setComment('');
      setPendingDecision(null);
      toast.success(
        decision === 'approve'
          ? `Approved version ${review.versionNumber}`
          : decision === 'reject'
            ? 'Rejected'
            : 'Changes requested',
      );
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not record that decision');
    }
  };

  return (
    <li className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{review.fileName}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Version {review.versionNumber} · requested by {review.requestedByName} ·{' '}
            {formatRelativeTime(review.createdAt)}
          </p>
        </div>
        <StatusBadge status={review.status} />
      </div>

      {review.requestNote ? (
        <p className="mt-2 rounded-md bg-muted p-2.5 text-sm">{review.requestNote}</p>
      ) : null}

      <p className="mt-2 text-xs text-muted-foreground">
        {review.approvalsSoFar} of {review.requiredApprovals} approvals ·{' '}
        <span className="font-mono">{review.versionChecksum.slice(0, 16)}…</span>
      </p>

      {review.decisions.length > 0 ? (
        <ol className="mt-3 space-y-1.5">
          {review.decisions.map((decision, index) => (
            <li key={index} className="flex items-start gap-2 text-xs">
              <DecisionIcon decision={decision.decision} />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{decision.reviewerName}</span>{' '}
                <span className="text-muted-foreground">
                  {decision.decision.replace('_', ' ')} · {formatRelativeTime(decision.decidedAt)}
                </span>
                {decision.comment ? (
                  <span className="mt-0.5 block whitespace-pre-wrap">{decision.comment}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {review.capabilities.canDecide ? (
        <div className="mt-3 space-y-2 border-t pt-3">
          <textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={2}
            placeholder={
              pendingDecision
                ? 'Required — say what needs to change'
                : 'Optional note (required to reject or request changes)'
            }
            aria-invalid={pendingDecision !== null && !comment.trim()}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={decide.isPending} onClick={() => submit('approve')}>
              {decide.isPending ? (
                <Loader2 className="mr-2 size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <ThumbsUp className="mr-2 size-3.5" aria-hidden="true" />
              )}
              Approve version {review.versionNumber}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending}
              onClick={() => submit('request_changes')}
            >
              Request changes
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              disabled={decide.isPending}
              onClick={() => submit('reject')}
            >
              <ThumbsDown className="mr-2 size-3.5" aria-hidden="true" />
              Reject
            </Button>
          </div>
        </div>
      ) : null}

      {review.capabilities.canCancel ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-3 h-7 text-xs"
          disabled={cancel.isPending}
          onClick={async () => {
            try {
              await cancel.mutateAsync(review.id);
              toast.success('Review withdrawn');
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : 'Could not withdraw');
            }
          }}
        >
          Withdraw request
        </Button>
      ) : null}
    </li>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'approved') {
    return <Badge className="bg-emerald-600 hover:bg-emerald-600">Approved</Badge>;
  }
  if (status === 'rejected') return <Badge variant="destructive">Rejected</Badge>;
  if (status === 'pending') {
    return (
      <Badge variant="secondary" className="gap-1">
        <Clock className="size-3" aria-hidden="true" />
        {STATUS_LABEL[status]}
      </Badge>
    );
  }
  return <Badge variant="outline">{STATUS_LABEL[status] ?? status}</Badge>;
}

function DecisionIcon({ decision }: { decision: ReviewDecision }) {
  if (decision === 'approve') {
    return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />;
  }
  if (decision === 'reject') {
    return <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />;
  }
  return <Clock className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden="true" />;
}
