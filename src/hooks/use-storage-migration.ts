'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';

/**
 * The *outbound* storage migration: this platform's files into the company Shared Drive.
 *
 * Not `use-migrations.ts`, which is the inbound Drive importer running the other way.
 */
export type StorageJobStatus =
  | 'draft'
  | 'planning'
  | 'planned'
  | 'running'
  | 'paused'
  | 'completed'
  | 'completed_with_failures'
  | 'failed'
  | 'cancelled';

export type StorageMigrationMode = 'dry_run' | 'migrate' | 'verify_only' | 'rollback';

export interface StorageJobDto {
  id: string;
  name: string;
  mode: StorageMigrationMode;
  status: StorageJobStatus;
  counters: {
    selected: number;
    selectedBytes: number;
    uploaded: number;
    uploadedBytes: number;
    verified: number;
    failed: number;
    skipped: number;
    rolledBack: number;
  };
  failureCounts: Record<string, number>;
  pauseRequested: boolean;
  plannedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface StorageJobDetail {
  job: StorageJobDto;
  itemCounts: Record<string, number>;
  openRecoveries: number;
}

export interface PlanReportDto {
  selected: number;
  selectedBytes: number;
  alreadyMigrated: number;
  skippedNative: number;
  tooDeep: Array<{ id: string; name: string; depth: number }>;
  itemProjection: {
    projectedItems: number;
    limit: number;
    withinLimit: boolean;
    approachingLimit: boolean;
  };
  distinctFolders: number;
}

export interface StorageItemDto {
  id: string;
  displayName: string;
  versionNumber: number;
  sizeBytes: number;
  status: string;
  attempts: number;
  failureCode: string | null;
  failureDetail: string | null;
  transferMs: number | null;
}

const KEY = ['storage-migration'];

export function useStorageJobs() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiRequest<StorageJobDto[]>('/api/admin/storage-migration'),
  });
}

export function useStorageJob(jobId: string | null, options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: [...KEY, jobId],
    queryFn: () => apiRequest<StorageJobDetail>(`/api/admin/storage-migration/${jobId}`),
    enabled: Boolean(jobId),
    // A run is driven by a request that may take minutes; polling is how the numbers move
    // without the operator reloading the page.
    refetchInterval: options.poll ? 3000 : false,
  });
}

export function useStorageJobItems(jobId: string | null, failedOnly: boolean) {
  return useQuery({
    queryKey: [...KEY, jobId, 'items', failedOnly],
    queryFn: () =>
      apiRequest<StorageItemDto[]>(
        `/api/admin/storage-migration/${jobId}/items?limit=200${failedOnly ? '&failedOnly=1' : ''}`,
      ),
    enabled: Boolean(jobId),
  });
}

function useJobAction<T>(path: string, body?: unknown) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      apiRequest<T>(`/api/admin/storage-migration/${jobId}/${path}`, {
        method: 'POST',
        body: body ?? {},
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useCreateStorageJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      mode: StorageMigrationMode;
      selection: Record<string, unknown>;
    }) => apiRequest<{ id: string }>('/api/admin/storage-migration', { method: 'POST', body: input }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export const usePlanStorageJob = () => useJobAction<PlanReportDto>('plan');
/** Bounded so one request cannot outlive the platform ceiling; call again to continue. */
export const useRunStorageJob = () => useJobAction<{ verified: number; failed: number; stoppedBecause: string }>('run', { maxItems: 200 });
export const usePauseStorageJob = () => useJobAction<{ pauseRequested: boolean }>('pause');
export const useRetryStorageJob = () => useJobAction<{ requeued: number }>('retry');
export const useVerifyStorageJob = () => useJobAction<{ checked: number; ok: number; failed: number }>('verify');
export const useRollbackStorageJob = () => useJobAction<{ rolledBack: number; skipped: number }>('rollback');
