'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type { FileDto } from './use-files';
import type { FolderDto } from './use-drive';

export type ShareTargetType = 'file' | 'folder';
export type PrincipalType = 'user' | 'department' | 'project' | 'role';
export type AccessLevel = 'viewer' | 'commenter' | 'editor' | 'reviewer' | 'approver' | 'manager';

export interface ShareEntryDto {
  principalType: PrincipalType;
  principalId: string;
  principalName: string;
  principalEmail: string | null;
  accessLevel: AccessLevel;
  deny: boolean;
  expiresAt: string | null;
  inherited: boolean;
  inheritedFromFolderId: string | null;
  inheritedFromFolderName: string | null;
}

export interface ShareStateDto {
  targetType: ShareTargetType;
  targetId: string;
  targetName: string;
  inheritPermissions: boolean;
  ownerId: string;
  confidentiality: string;
  capabilities: { canShare: boolean; canManageAccess: boolean };
  entries: ShareEntryDto[];
}

export interface CommentDto {
  id: string;
  fileId: string;
  versionId: string | null;
  versionNumber: number | null;
  parentCommentId: string | null;
  authorUserId: string;
  authorName: string;
  body: string;
  mentionedUserIds: string[];
  isReviewComment: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  editedAt: string | null;
  createdAt: string;
  capabilities: { canEdit: boolean; canDelete: boolean; canResolve: boolean };
  replies: Array<{
    id: string;
    parentCommentId: string | null;
    authorUserId: string;
    authorName: string;
    body: string;
    mentionedUserIds: string[];
    editedAt: string | null;
    createdAt: string;
  }>;
}

export interface NotificationDto {
  id: string;
  type: string;
  actorUserId: string | null;
  actorName: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

const basePath = (targetType: ShareTargetType, targetId: string) =>
  targetType === 'file' ? `/api/files/${targetId}` : `/api/folders/${targetId}`;

export const sharingKeys = {
  share: (targetType: ShareTargetType, targetId: string) =>
    ['share', targetType, targetId] as const,
  sharedWithMe: () => ['shared-with-me'] as const,
  comments: (fileId: string) => ['comments', fileId] as const,
  notifications: () => ['notifications'] as const,
};

export function useShareState(targetType: ShareTargetType, targetId: string | null) {
  return useQuery({
    queryKey: sharingKeys.share(targetType, targetId ?? ''),
    queryFn: () => apiRequest<ShareStateDto>(`${basePath(targetType, targetId!)}/permissions`),
    enabled: Boolean(targetId),
  });
}

/**
 * A share change alters who can see what, so the invalidation is deliberately broad:
 * drive listings, search results and "shared with me" can all change from one grant.
 */
function useShareMutation<TVariables, TData>(mutationFn: (variables: TVariables) => Promise<TData>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['share'] });
      void queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      void queryClient.invalidateQueries({ queryKey: ['folder'] });
      void queryClient.invalidateQueries({ queryKey: ['file'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
    },
  });
}

export function useShare() {
  return useShareMutation(
    (input: {
      targetType: ShareTargetType;
      targetId: string;
      principalType: PrincipalType;
      principalId: string;
      accessLevel: AccessLevel;
      deny?: boolean;
      expiresAt?: string | null;
    }) => {
      const { targetType, targetId, ...body } = input;
      return apiRequest<ShareStateDto>(`${basePath(targetType, targetId)}/permissions`, {
        method: 'POST',
        body,
      });
    },
  );
}

export function useRevokeShare() {
  return useShareMutation(
    (input: {
      targetType: ShareTargetType;
      targetId: string;
      principalType: PrincipalType;
      principalId: string;
    }) => {
      const { targetType, targetId, ...body } = input;
      return apiRequest<ShareStateDto>(`${basePath(targetType, targetId)}/permissions`, {
        method: 'DELETE',
        body,
      });
    },
  );
}

export function useSetInheritance() {
  return useShareMutation(
    (input: { targetType: ShareTargetType; targetId: string; inherit: boolean }) =>
      apiRequest<ShareStateDto>(
        `${basePath(input.targetType, input.targetId)}/permissions/inheritance`,
        { method: 'PUT', body: { inherit: input.inherit } },
      ),
  );
}

export function useSharedWithMe() {
  return useQuery({
    queryKey: sharingKeys.sharedWithMe(),
    queryFn: () => apiRequest<{ files: FileDto[]; folders: FolderDto[] }>('/api/shared'),
  });
}

/* ------------------------------------------------------------------ comments */

export function useComments(fileId: string | null, includeResolved = false) {
  return useQuery({
    queryKey: [...sharingKeys.comments(fileId ?? ''), includeResolved] as const,
    queryFn: () =>
      apiRequest<CommentDto[]>(
        `/api/files/${fileId}/comments?includeResolved=${includeResolved ? 'true' : 'false'}`,
      ),
    enabled: Boolean(fileId),
  });
}

function useCommentMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['comments'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useAddComment() {
  return useCommentMutation(
    (input: { fileId: string; body: string; parentCommentId?: string; versionId?: string }) => {
      const { fileId, ...body } = input;
      return apiRequest<CommentDto>(`/api/files/${fileId}/comments`, { method: 'POST', body });
    },
  );
}

export function useEditComment() {
  return useCommentMutation((input: { fileId: string; commentId: string; body: string }) =>
    apiRequest<CommentDto>(`/api/files/${input.fileId}/comments/${input.commentId}`, {
      method: 'PATCH',
      body: { body: input.body },
    }),
  );
}

export function useDeleteComment() {
  return useCommentMutation((input: { fileId: string; commentId: string }) =>
    apiRequest<void>(`/api/files/${input.fileId}/comments/${input.commentId}`, {
      method: 'DELETE',
    }),
  );
}

export function useResolveComment() {
  return useCommentMutation((input: { fileId: string; commentId: string; resolved: boolean }) =>
    apiRequest<CommentDto>(`/api/files/${input.fileId}/comments/${input.commentId}/resolve`, {
      method: 'PUT',
      body: { resolved: input.resolved },
    }),
  );
}

/* ------------------------------------------------------------- notifications */

export function useNotifications() {
  return useQuery({
    queryKey: sharingKeys.notifications(),
    queryFn: () =>
      apiRequest<{ items: NotificationDto[]; unread: number }>('/api/notifications?limit=30'),
    // Polled rather than pushed: a WebSocket for a badge that changes a few times a day
    // is not worth the connection, and the interval only runs while the tab is focused.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationId?: string) =>
      apiRequest<{ unread: number }>('/api/notifications/read', {
        method: 'POST',
        body: notificationId ? { notificationId } : {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sharingKeys.notifications() });
    },
  });
}

/* -------------------------------------------------------------- access history */

export interface AccessHistoryEntry {
  id: string;
  action: string;
  actorUserId: string | null;
  actorEmail: string | null;
  ip: string;
  at: string;
}

export function useAccessHistory(fileId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['access-history', fileId] as const,
    queryFn: () =>
      apiRequest<{ fileName: string; downloadCount: number; history: AccessHistoryEntry[] }>(
        `/api/files/${fileId}/access-history`,
      ),
    enabled: enabled && Boolean(fileId),
  });
}
