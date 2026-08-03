'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';

export type MigrationStatus =
  | 'draft'
  | 'connected'
  | 'scanning'
  | 'scanned'
  | 'importing'
  | 'paused'
  | 'needs_review'
  | 'partially_completed'
  | 'completed'
  | 'failed';

export type MigrationItemStatus =
  | 'pending'
  | 'importing'
  | 'imported'
  | 'skipped_duplicate'
  | 'skipped_unsupported'
  | 'needs_review'
  | 'failed';

export interface MigrationJobDto {
  id: string;
  name: string;
  description: string;
  status: MigrationStatus;
  targetFolderId: string;
  departmentId: string | null;
  projectId: string | null;
  confidentiality: string;
  sourceFolderIds: string[];
  /** No token, ever — `connected` is all the client is told. */
  connection: {
    connected: boolean;
    accountEmail: string | null;
    scope: string | null;
    connectedAt: string | null;
  };
  options: {
    preserveHierarchy: boolean;
    preserveDates: boolean;
    skipDuplicates: boolean;
    exportGoogleDocs: boolean;
  };
  counters: {
    scannedFiles: number;
    scannedFolders: number;
    scannedBytes: number;
    imported: number;
    importedBytes: number;
    skippedDuplicates: number;
    skippedUnsupported: number;
    failed: number;
  };
  scanStartedAt: string | null;
  scanCompletedAt: string | null;
  importStartedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationItemDto {
  id: string;
  driveFileId: string;
  sourcePath: string;
  name: string;
  mimeType: string;
  declaredSize: number;
  isGoogleNative: boolean;
  status: MigrationItemStatus;
  targetFolderId: string | null;
  resultFileId: string | null;
  checksumSha256: string | null;
  importedBytes: number;
  duplicateOfFileId: string | null;
  attempts: number;
  lastError: string | null;
  driveCreatedTime: string | null;
  driveModifiedTime: string | null;
  importedAt: string | null;
}

export interface ImportRunResult {
  processed: number;
  imported: number;
  skippedDuplicates: number;
  skippedUnsupported: number;
  failed: number;
  remaining: number;
  status: MigrationStatus;
}

export const migrationKeys = {
  list: () => ['migrations'] as const,
  job: (id: string) => ['migrations', id] as const,
  items: (id: string, status?: string) => ['migrations', id, 'items', status ?? 'all'] as const,
  report: (id: string) => ['migrations', id, 'report'] as const,
};

export function useMigrations() {
  return useQuery({
    queryKey: migrationKeys.list(),
    queryFn: () => apiRequest<MigrationJobDto[]>('/api/admin/migrations'),
  });
}

export function useMigration(jobId: string | null, options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: migrationKeys.job(jobId ?? ''),
    queryFn: () => apiRequest<MigrationJobDto>(`/api/admin/migrations/${jobId}`),
    enabled: Boolean(jobId),
    // A scan or import runs on the server; the page refreshes itself while it does.
    refetchInterval: options.poll ? 3000 : false,
  });
}

export function useMigrationItems(jobId: string | null, status?: MigrationItemStatus) {
  const params = new URLSearchParams({ pageSize: '50' });
  if (status) params.set('status', status);

  return useQuery({
    queryKey: migrationKeys.items(jobId ?? '', status),
    queryFn: () =>
      apiRequest<MigrationItemDto[]>(`/api/admin/migrations/${jobId}/items?${params.toString()}`),
    enabled: Boolean(jobId),
  });
}

export function useMigrationReport(jobId: string | null) {
  return useQuery({
    queryKey: migrationKeys.report(jobId ?? ''),
    queryFn: () =>
      apiRequest<{
        job: MigrationJobDto;
        byStatus: Record<string, number>;
        attention: MigrationItemDto[];
      }>(`/api/admin/migrations/${jobId}/report`),
    enabled: Boolean(jobId),
  });
}

function useMigrationMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['migrations'] });
      // An import creates folders and files: everything drive-shaped is stale.
      void queryClient.invalidateQueries({ queryKey: ['folder'] });
      void queryClient.invalidateQueries({ queryKey: ['drives'] });
      void queryClient.invalidateQueries({ queryKey: ['session'] });
    },
  });
}

export function useCreateMigration() {
  return useMigrationMutation(
    (body: {
      name: string;
      description?: string;
      targetFolderId: string;
      sourceFolderIds?: string[];
      confidentiality?: string;
      options?: Partial<MigrationJobDto['options']>;
    }) => apiRequest<MigrationJobDto>('/api/admin/migrations', { method: 'POST', body }),
  );
}

export function useUpdateMigration() {
  return useMigrationMutation(
    (input: {
      jobId: string;
      name?: string;
      description?: string;
      sourceFolderIds?: string[];
      options?: Partial<MigrationJobDto['options']>;
    }) => {
      const { jobId, ...body } = input;
      return apiRequest<MigrationJobDto>(`/api/admin/migrations/${jobId}`, {
        method: 'PATCH',
        body,
      });
    },
  );
}

export function useDeleteMigration() {
  return useMigrationMutation((jobId: string) =>
    apiRequest<void>(`/api/admin/migrations/${jobId}`, { method: 'DELETE' }),
  );
}

export function useBeginConnect() {
  return useMutation({
    mutationFn: (jobId: string) =>
      apiRequest<{ authorizationUrl: string; state: string }>(
        `/api/admin/migrations/${jobId}/connect`,
      ),
  });
}

export function useCompleteConnect() {
  return useMigrationMutation((input: { jobId: string; code: string; state: string }) => {
    const { jobId, ...body } = input;
    return apiRequest<MigrationJobDto>(`/api/admin/migrations/${jobId}/connect`, {
      method: 'POST',
      body,
    });
  });
}

export function useScanMigration() {
  return useMigrationMutation((jobId: string) =>
    apiRequest<{ files: number; folders: number; bytes: number; truncated: boolean }>(
      `/api/admin/migrations/${jobId}/scan`,
      { method: 'POST' },
    ),
  );
}

export function useRunMigration() {
  return useMigrationMutation((input: { jobId: string; limit?: number }) =>
    apiRequest<ImportRunResult>(`/api/admin/migrations/${input.jobId}/run`, {
      method: 'POST',
      body: { limit: input.limit ?? 25 },
    }),
  );
}

export function usePauseMigration() {
  return useMigrationMutation((jobId: string) =>
    apiRequest<MigrationJobDto>(`/api/admin/migrations/${jobId}/pause`, { method: 'POST' }),
  );
}

export function useRetryMigration() {
  return useMigrationMutation((jobId: string) =>
    apiRequest<{ requeued: number }>(`/api/admin/migrations/${jobId}/retry`, { method: 'POST' }),
  );
}
