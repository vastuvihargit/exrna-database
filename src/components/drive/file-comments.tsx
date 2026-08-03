'use client';

import * as React from 'react';
import { Check, CornerDownRight, Loader2, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/utils';
import type { FileDto } from '@/hooks/use-files';
import {
  useAddComment,
  useComments,
  useDeleteComment,
  useEditComment,
  useResolveComment,
  type CommentDto,
} from '@/hooks/use-sharing';

/**
 * The discussion thread for one file.
 *
 * Comments are available on approved files too: a comment cannot change the file, so the
 * approved-file lock does not apply, and forcing the discussion elsewhere would take it
 * out of the record.
 *
 * `@name` or `@email` mentions notify the person — but only if they can already open the
 * file. A mention is not a grant, and the server drops mentions of people without access
 * rather than sending them a notification naming a file they may not know exists.
 */
export function FileComments({ file }: { file: FileDto }) {
  const [includeResolved, setIncludeResolved] = React.useState(false);
  const comments = useComments(file.id, includeResolved);
  const add = useAddComment();

  const [draft, setDraft] = React.useState('');
  const [replyingTo, setReplyingTo] = React.useState<string | null>(null);

  const submit = async (parentCommentId?: string) => {
    const body = draft.trim();
    if (!body) return;
    try {
      await add.mutateAsync({
        fileId: file.id,
        body,
        ...(parentCommentId ? { parentCommentId } : {}),
      });
      setDraft('');
      setReplyingTo(null);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not post that comment');
    }
  };

  const threads = comments.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          Comments
          {threads.length > 0 ? (
            <span className="ml-1.5 text-muted-foreground">{threads.length}</span>
          ) : null}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setIncludeResolved((current) => !current)}
        >
          {includeResolved ? 'Hide resolved' : 'Show resolved'}
        </Button>
      </div>

      {file.capabilities.canComment ? (
        <div className="space-y-1.5">
          <textarea
            value={replyingTo === null ? draft : ''}
            onChange={(event) => {
              setReplyingTo(null);
              setDraft(event.target.value);
            }}
            rows={2}
            placeholder="Add a comment — use @name to notify a colleague"
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={add.isPending || (replyingTo !== null ? true : !draft.trim())}
            onClick={() => submit()}
          >
            {add.isPending ? (
              <Loader2 className="mr-1.5 size-3 animate-spin" aria-hidden="true" />
            ) : null}
            Comment
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">You do not have permission to comment here.</p>
      )}

      {comments.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading comments…</p>
      ) : threads.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No comments yet. Questions about a result belong here rather than in email — this is
          part of the file&rsquo;s record.
        </p>
      ) : (
        <ol className="space-y-3">
          {threads.map((thread) => (
            <Thread
              key={thread.id}
              fileId={file.id}
              comment={thread}
              isReplying={replyingTo === thread.id}
              replyDraft={replyingTo === thread.id ? draft : ''}
              onReplyDraftChange={(value) => {
                setReplyingTo(thread.id);
                setDraft(value);
              }}
              onStartReply={() => {
                setReplyingTo(thread.id);
                setDraft('');
              }}
              onCancelReply={() => {
                setReplyingTo(null);
                setDraft('');
              }}
              onSubmitReply={() => submit(thread.id)}
              isSubmitting={add.isPending}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function Thread({
  fileId,
  comment,
  isReplying,
  replyDraft,
  onReplyDraftChange,
  onStartReply,
  onCancelReply,
  onSubmitReply,
  isSubmitting,
}: {
  fileId: string;
  comment: CommentDto;
  isReplying: boolean;
  replyDraft: string;
  onReplyDraftChange: (value: string) => void;
  onStartReply: () => void;
  onCancelReply: () => void;
  onSubmitReply: () => void;
  isSubmitting: boolean;
}) {
  const edit = useEditComment();
  const remove = useDeleteComment();
  const resolve = useResolveComment();

  const [editing, setEditing] = React.useState(false);
  const [editDraft, setEditDraft] = React.useState(comment.body);

  return (
    <li className={`rounded-md border p-2.5 text-xs ${comment.resolvedAt ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{comment.authorName}</span>
        <span className="text-muted-foreground">{formatRelativeTime(comment.createdAt)}</span>
        {comment.versionNumber ? (
          <Badge variant="outline" className="text-[10px]">
            v{comment.versionNumber}
          </Badge>
        ) : null}
        {comment.resolvedAt ? (
          <Badge variant="secondary" className="text-[10px]">
            Resolved
          </Badge>
        ) : null}
        {comment.editedAt ? <span className="text-muted-foreground">(edited)</span> : null}
      </div>

      {editing ? (
        <div className="mt-1.5 space-y-1.5">
          <textarea
            value={editDraft}
            onChange={(event) => setEditDraft(event.target.value)}
            rows={2}
            className="flex w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs"
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              className="h-6 text-[11px]"
              disabled={edit.isPending || !editDraft.trim()}
              onClick={async () => {
                try {
                  await edit.mutateAsync({ fileId, commentId: comment.id, body: editDraft });
                  setEditing(false);
                } catch (error) {
                  toast.error(error instanceof ApiError ? error.message : 'Could not save the edit');
                }
              }}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[11px]"
              onClick={() => {
                setEditing(false);
                setEditDraft(comment.body);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap break-words">{comment.body}</p>
      )}

      {comment.replies.length > 0 ? (
        <ol className="mt-2 space-y-2 border-l pl-2.5">
          {comment.replies.map((reply) => (
            <li key={reply.id}>
              <div className="flex items-center gap-2">
                <CornerDownRight className="size-3 text-muted-foreground" aria-hidden="true" />
                <span className="font-medium">{reply.authorName}</span>
                <span className="text-muted-foreground">{formatRelativeTime(reply.createdAt)}</span>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap break-words pl-5">{reply.body}</p>
            </li>
          ))}
        </ol>
      ) : null}

      {isReplying ? (
        <div className="mt-2 space-y-1.5">
          <textarea
            value={replyDraft}
            onChange={(event) => onReplyDraftChange(event.target.value)}
            rows={2}
            placeholder="Reply…"
            autoFocus
            className="flex w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs"
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              className="h-6 text-[11px]"
              disabled={isSubmitting || !replyDraft.trim()}
              onClick={onSubmitReply}
            >
              Reply
            </Button>
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={onCancelReply}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={onStartReply}>
            Reply
          </Button>

          {comment.capabilities.canResolve ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px]"
              disabled={resolve.isPending}
              onClick={() =>
                resolve.mutate({
                  fileId,
                  commentId: comment.id,
                  resolved: !comment.resolvedAt,
                })
              }
            >
              <Check className="mr-1 size-3" aria-hidden="true" />
              {comment.resolvedAt ? 'Reopen' : 'Resolve'}
            </Button>
          ) : null}

          {comment.capabilities.canEdit ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px]"
              onClick={() => setEditing(true)}
            >
              <Pencil className="mr-1 size-3" aria-hidden="true" />
              Edit
            </Button>
          ) : null}

          {comment.capabilities.canDelete ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px]"
              disabled={remove.isPending}
              onClick={async () => {
                try {
                  await remove.mutateAsync({ fileId, commentId: comment.id });
                  toast.success('Comment deleted');
                } catch (error) {
                  toast.error(
                    error instanceof ApiError ? error.message : 'Could not delete that comment',
                  );
                }
              }}
            >
              <Trash2 className="mr-1 size-3" aria-hidden="true" />
              Delete
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
}
