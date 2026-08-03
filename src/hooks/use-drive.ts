'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type { FileDto } from './use-files';

/** Mirrors `toFolderDto` on the server. Nothing physical is ever present here. */
export interface FolderDto {
  id: string;
  name: string;
  parentFolderId: string | null;
  pathAncestors: string[];
  depth: number;
  driveType: 'my' | 'department' | 'project';
  ownerId: string;
  departmentId: string | null;
  projectId: string | null;
  confidentiality: 'public_internal' | 'internal' | 'confidential' | 'restricted';
  status: 'active' | 'archived' | 'trashed';
  description: string;
  color: string | null;
  templateKey: string | null;
  isSystem: boolean;
  isRoot: boolean;
  inheritPermissions: boolean;
  childFolderCount: number;
  fileCount: number;
  isStarred: boolean;
  capabilities: {
    canCreateFolder: boolean;
    canUpload: boolean;
    canRename: boolean;
    canMove: boolean;
    canCopy: boolean;
    canDelete: boolean;
    canArchive: boolean;
    canRestore: boolean;
    canShare: boolean;
    canManageAccess: boolean;
    canDownload: boolean;
  };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface BreadcrumbDto {
  id: string;
  name: string;
  driveType: string;
  isRoot: boolean;
}

export interface FolderPayload {
  folder: FolderDto;
  breadcrumbs: BreadcrumbDto[];
}

export interface DriveSummaryDto {
  id: string;
  kind: 'my' | 'department' | 'project';
  name: string;
  code?: string;
  departmentId?: string;
  rootFolderId: string | null;
  href: string;
}

export interface DrivesPayload {
  myDrive: DriveSummaryDto;
  departments: DriveSummaryDto[];
  projects: DriveSummaryDto[];
}

export interface ChildrenPayload {
  folders: FolderDto[];
  files: FileDto[];
}

export interface ListQuery {
  page: number;
  pageSize: number;
  sort: 'name' | 'updatedAt' | 'createdAt';
  order: 'asc' | 'desc';
  search?: string;
}

export const driveKeys = {
  drives: ['drives'] as const,
  folder: (id: string) => ['folder', id] as const,
  children: (id: string, query: ListQuery) => ['folder', id, 'children', query] as const,
  activity: (id: string) => ['folder', id, 'activity'] as const,
  trash: (page: number) => ['trash', page] as const,
  starred: ['starred'] as const,
  recent: ['recent'] as const,
  projects: ['projects'] as const,
};

export function useDrives() {
  return useQuery({
    queryKey: driveKeys.drives,
    queryFn: () => apiRequest<DrivesPayload>('/api/drives'),
    staleTime: 60_000,
  });
}

export function useMyDrive() {
  return useQuery({
    queryKey: ['drives', 'my'],
    queryFn: () => apiRequest<FolderPayload>('/api/drives/my'),
  });
}

export function useDepartmentDrive(departmentId: string | null) {
  return useQuery({
    queryKey: ['drives', 'department', departmentId],
    queryFn: () => apiRequest<FolderPayload>(`/api/drives/departments/${departmentId}`),
    enabled: Boolean(departmentId),
  });
}

export function useProjectDrive(projectId: string | null) {
  return useQuery({
    queryKey: ['drives', 'project', projectId],
    queryFn: () => apiRequest<FolderPayload>(`/api/drives/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
}

export function useFolder(folderId: string | null) {
  return useQuery({
    queryKey: driveKeys.folder(folderId ?? ''),
    queryFn: () => apiRequest<FolderPayload>(`/api/folders/${folderId}`),
    enabled: Boolean(folderId),
  });
}

export function useFolderChildren(folderId: string | null, query: ListQuery) {
  const search = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
    sort: query.sort,
    order: query.order,
    ...(query.search ? { search: query.search } : {}),
  });

  return useQuery({
    queryKey: driveKeys.children(folderId ?? '', query),
    queryFn: () =>
      apiRequest<ChildrenPayload>(`/api/folders/${folderId}/children?${search.toString()}`),
    enabled: Boolean(folderId),
    // Keeps the previous page visible while the next one loads, so paging does not
    // flash an empty table.
    placeholderData: keepPreviousData,
  });
}

export function useFolderActivity(folderId: string | null) {
  return useQuery({
    queryKey: driveKeys.activity(folderId ?? ''),
    queryFn: () =>
      apiRequest<
        Array<{
          id: string;
          actorName: string;
          action: string;
          entityLabel: string;
          createdAt: string;
        }>
      >(`/api/folders/${folderId}/activity`),
    enabled: Boolean(folderId),
  });
}

export function useTrash(page: number) {
  return useQuery({
    queryKey: driveKeys.trash(page),
    queryFn: () => apiRequest<ChildrenPayload>(`/api/trash?page=${page}&pageSize=50`),
  });
}

export function useArchive(page: number) {
  return useQuery({
    queryKey: ['archive', page],
    queryFn: () => apiRequest<ChildrenPayload>(`/api/archive?page=${page}&pageSize=50`),
  });
}

export function useStarred() {
  return useQuery({
    queryKey: driveKeys.starred,
    queryFn: () => apiRequest<ChildrenPayload>('/api/starred'),
  });
}

export function useRecent() {
  return useQuery({
    queryKey: driveKeys.recent,
    queryFn: () => apiRequest<ChildrenPayload>('/api/recent'),
  });
}

export function useProjects() {
  return useQuery({
    queryKey: driveKeys.projects,
    queryFn: () =>
      apiRequest<
        Array<{
          id: string;
          name: string;
          code: string;
          departmentId: string;
          status: string;
          rootFolderId: string | null;
          fileCount: number;
          storageUsedBytes: number;
        }>
      >('/api/projects'),
  });
}

/**
 * Every mutation invalidates broadly rather than patching the cache by hand.
 *
 * A move or a trash changes counts and contents in two folders at once, and an
 * optimistic patch that gets one of them wrong shows the user a drive that does not
 * exist. Refetching is cheap; being wrong about where a file is, is not.
 */
function useDriveMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['folder'] });
      void queryClient.invalidateQueries({ queryKey: ['drives'] });
      void queryClient.invalidateQueries({ queryKey: ['trash'] });
      void queryClient.invalidateQueries({ queryKey: ['archive'] });
      void queryClient.invalidateQueries({ queryKey: ['starred'] });
      void queryClient.invalidateQueries({ queryKey: ['recent'] });
    },
  });
}

export function useCreateFolder() {
  return useDriveMutation((input: { name: string; parentFolderId: string; description?: string }) =>
    apiRequest<FolderDto>('/api/folders', { method: 'POST', body: input }),
  );
}

export function useRenameFolder() {
  return useDriveMutation((input: { folderId: string; name: string }) =>
    apiRequest<FolderDto>(`/api/folders/${input.folderId}/rename`, {
      method: 'POST',
      body: { name: input.name },
    }),
  );
}

export function useMoveFolder() {
  return useDriveMutation((input: { folderId: string; targetParentFolderId: string }) =>
    apiRequest<FolderDto>(`/api/folders/${input.folderId}/move`, {
      method: 'POST',
      body: { targetParentFolderId: input.targetParentFolderId },
    }),
  );
}

export function useCopyFolder() {
  return useDriveMutation((input: { folderId: string; targetParentFolderId: string }) =>
    apiRequest<FolderDto>(`/api/folders/${input.folderId}/copy`, {
      method: 'POST',
      body: { targetParentFolderId: input.targetParentFolderId },
    }),
  );
}

export function useTrashFolder() {
  return useDriveMutation((folderId: string) =>
    apiRequest<{ affected: number }>(`/api/folders/${folderId}`, { method: 'DELETE' }),
  );
}

export function useRestoreFolder() {
  return useDriveMutation((folderId: string) =>
    apiRequest<FolderDto>(`/api/folders/${folderId}/restore`, { method: 'POST' }),
  );
}

export function useArchiveFolder() {
  return useDriveMutation((input: { folderId: string; archived: boolean }) =>
    apiRequest<FolderDto>(`/api/folders/${input.folderId}/archive`, {
      method: 'POST',
      body: { archived: input.archived },
    }),
  );
}

export function useStarFolder() {
  return useDriveMutation((input: { folderId: string; starred: boolean }) =>
    apiRequest<{ isStarred: boolean }>(`/api/folders/${input.folderId}/star`, {
      method: 'PUT',
      body: { starred: input.starred },
    }),
  );
}

export function useUpdateFolder() {
  return useDriveMutation(
    (input: { folderId: string; description?: string; confidentiality?: string }) => {
      const { folderId, ...body } = input;
      return apiRequest<FolderDto>(`/api/folders/${folderId}`, { method: 'PATCH', body });
    },
  );
}
