'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';

/**
 * Mirrors `toFileDto` on the server.
 *
 * There is no storage key, no path and no version key — and deliberately no field to
 * put one in. Bytes are obtained from the download endpoint, which checks permission
 * and streams; the client never learns where a file lives.
 */
export interface FileDto {
  id: string;
  displayName: string;
  originalFilename: string;
  extension: string;
  category: string;
  folderId: string;
  driveType: 'my' | 'department' | 'project';
  ownerId: string;
  departmentId: string | null;
  projectId: string | null;
  experimentId: string | null;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  versionCount: number;
  sizeBytes: number;
  mimeType: string;
  checksumSha256: string;
  tags: string[];
  metadata: Record<string, unknown>;
  confidentiality: 'public_internal' | 'internal' | 'confidential' | 'restricted';
  reviewStatus: string;
  approvalStatus: string;
  status: 'active' | 'archived' | 'trashed';
  inheritPermissions: boolean;
  downloadCount: number;
  isStarred: boolean;
  previewable: boolean;
  /** A Google Doc, Sheet or Slide, on a deployment where opening it in Google is allowed. */
  opensInGoogleEditor: boolean;
  capabilities: {
    canPreview: boolean;
    canDownload: boolean;
    canRename: boolean;
    canMove: boolean;
    canCopy: boolean;
    canDelete: boolean;
    canArchive: boolean;
    canRestore: boolean;
    canUploadVersion: boolean;
    canEditMetadata: boolean;
    canComment: boolean;
    canShare: boolean;
    canManageAccess: boolean;
    canSubmitForReview: boolean;
    canReview: boolean;
    canApprove: boolean;
  };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface VersionDto {
  id: string;
  fileId: string;
  versionNumber: number;
  originalFilename: string;
  fileSize: number;
  mimeType: string;
  extension: string;
  checksumSha256: string;
  uploadedBy: string;
  uploadedAt: string;
  versionNote: string | null;
  restoredFromVersionId: string | null;
  processingStatus: string;
  label: string;
  isCurrent: boolean;
  isApproved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Set when the document changed after it was approved. The reason is a plain sentence. */
  approvalSupersededAt: string | null;
  approvalSupersededReason: string | null;
  previewStatus: string;
}

export const fileKeys = {
  file: (id: string) => ['file', id] as const,
  versions: (id: string) => ['file', id, 'versions'] as const,
};

export function useFile(fileId: string | null) {
  return useQuery({
    queryKey: fileKeys.file(fileId ?? ''),
    queryFn: () => apiRequest<FileDto>(`/api/files/${fileId}`),
    enabled: Boolean(fileId),
  });
}

export function useFileVersions(fileId: string | null) {
  return useQuery({
    queryKey: fileKeys.versions(fileId ?? ''),
    queryFn: () => apiRequest<VersionDto[]>(`/api/files/${fileId}/versions`),
    enabled: Boolean(fileId),
  });
}

/**
 * File mutations invalidate the same broad set as folder mutations.
 *
 * A move changes two folders' contents and both their counts; a trash changes a folder
 * count and the trash listing. Refetching is cheap next to showing someone a drive that
 * does not exist.
 */
function useFileMutation<TVariables, TData>(mutationFn: (variables: TVariables) => Promise<TData>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['folder'] });
      void queryClient.invalidateQueries({ queryKey: ['file'] });
      void queryClient.invalidateQueries({ queryKey: ['drives'] });
      void queryClient.invalidateQueries({ queryKey: ['trash'] });
      void queryClient.invalidateQueries({ queryKey: ['archive'] });
      void queryClient.invalidateQueries({ queryKey: ['starred'] });
      void queryClient.invalidateQueries({ queryKey: ['recent'] });
      void queryClient.invalidateQueries({ queryKey: ['session'] });
    },
  });
}

export function useRenameFile() {
  return useFileMutation((input: { fileId: string; name: string }) =>
    apiRequest<FileDto>(`/api/files/${input.fileId}/rename`, {
      method: 'POST',
      body: { name: input.name },
    }),
  );
}

export function useMoveFile() {
  return useFileMutation((input: { fileId: string; targetFolderId: string }) =>
    apiRequest<FileDto>(`/api/files/${input.fileId}/move`, {
      method: 'POST',
      body: { targetFolderId: input.targetFolderId },
    }),
  );
}

export function useCopyFile() {
  return useFileMutation((input: { fileId: string; targetFolderId: string }) =>
    apiRequest<FileDto>(`/api/files/${input.fileId}/copy`, {
      method: 'POST',
      body: { targetFolderId: input.targetFolderId },
    }),
  );
}

export function useTrashFile() {
  return useFileMutation((fileId: string) =>
    apiRequest<void>(`/api/files/${fileId}`, { method: 'DELETE' }),
  );
}

export function useRestoreFile() {
  return useFileMutation((fileId: string) =>
    apiRequest<FileDto>(`/api/files/${fileId}/restore`, { method: 'POST' }),
  );
}

export function useStarFile() {
  return useFileMutation((input: { fileId: string; starred: boolean }) =>
    apiRequest<{ isStarred: boolean }>(`/api/files/${input.fileId}/star`, {
      method: 'PUT',
      body: { starred: input.starred },
    }),
  );
}

export function useUpdateFile() {
  return useFileMutation(
    (input: {
      fileId: string;
      tags?: string[];
      confidentiality?: string;
      category?: string;
      projectId?: string | null;
      experimentId?: string | null;
      metadata?: Record<string, unknown>;
    }) => {
      const { fileId, ...body } = input;
      return apiRequest<FileDto>(`/api/files/${fileId}`, { method: 'PATCH', body });
    },
  );
}

/**
 * Restoring an older version appends a new one — the response is the version that was
 * just created, not the one that was named.
 */
export function useRestoreVersion() {
  return useFileMutation((input: { fileId: string; versionId: string; note?: string }) =>
    apiRequest<VersionDto>(`/api/files/${input.fileId}/versions/${input.versionId}/restore`, {
      method: 'POST',
      body: input.note ? { note: input.note } : {},
    }),
  );
}

export function useUpdateVersionNote() {
  return useFileMutation((input: { fileId: string; versionId: string; note: string }) =>
    apiRequest<VersionDto>(`/api/files/${input.fileId}/versions/${input.versionId}`, {
      method: 'PATCH',
      body: { note: input.note },
    }),
  );
}
