'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type { FileDto } from './use-files';

/** Mirrors `toExperimentDto`. */
export interface ExperimentDto {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  departmentId: string | null;
  code: string;
  title: string;
  objective: string;
  status: 'planned' | 'in_progress' | 'completed' | 'aborted' | 'archived';
  outcome: 'pending' | 'positive' | 'negative' | 'inconclusive' | 'failed';
  outcomeSummary: string;
  leadUserId: string | null;
  collaboratorUserIds: string[];
  protocolRef: string;
  instrumentRef: string;
  organism: string;
  sampleIds: string[];
  startedOn: string | null;
  completedOn: string | null;
  folderId: string | null;
  confidentiality: string;
  tags: string[];
  fileCount: number;
  capabilities: { edit: boolean; delete: boolean };
  createdAt: string;
  updatedAt: string;
}

export type RelationReason = 'duplicate' | 'experiment' | 'sample' | 'experiment_code';

export interface RelatedFileDto {
  reasons: RelationReason[];
  file: FileDto;
}

export interface ProjectOverviewDto {
  project: {
    id: string;
    name: string;
    code: string;
    description: string;
    departmentId: string;
    leadUserId: string | null;
    memberUserIds: string[];
    rootFolderId: string | null;
    status: string;
    confidentiality: string;
    startDate: string | null;
    targetEndDate: string | null;
    completedAt: string | null;
    tags: string[];
    storageUsedBytes: number;
    fileCount: number;
    createdAt: string;
  };
  department: { id: string; name: string; code: string } | null;
  members: Array<{ id: string; name: string; email: string; isLead: boolean }>;
  content: {
    totalFiles: number;
    totalBytes: number;
    byCategory: Array<{ value: string; count: number; bytes: number }>;
    byDocumentType: Array<{ value: string; count: number; bytes: number }>;
    byReviewStatus: Array<{ value: string; count: number }>;
    linkedToExperiment: number;
  };
  experiments: { total: number; byStatus: Record<string, number> };
  recentExperiments: ExperimentDto[];
  activity: Array<{
    id: string;
    actorUserId: string;
    actorName: string;
    action: string;
    entityType: string;
    entityId: string;
    entityLabel: string;
    createdAt: string;
  }>;
  missingTemplateFolders: Array<{ key: string; name: string }>;
}

export const researchKeys = {
  experiments: (projectId?: string) => ['experiments', projectId ?? 'all'] as const,
  experiment: (id: string) => ['experiment', id] as const,
  overview: (projectId: string) => ['project-overview', projectId] as const,
  related: (fileId: string) => ['file', fileId, 'related'] as const,
};

export function useExperiments(
  input: { projectId?: string; q?: string; status?: string; enabled?: boolean } = {},
) {
  const params = new URLSearchParams({ pageSize: '100' });
  if (input.projectId) params.set('projectId', input.projectId);
  if (input.q) params.set('q', input.q);
  if (input.status) params.set('status', input.status);

  return useQuery({
    queryKey: [...researchKeys.experiments(input.projectId), input.q ?? '', input.status ?? ''],
    queryFn: () => apiRequest<ExperimentDto[]>(`/api/experiments?${params.toString()}`),
    enabled: input.enabled ?? true,
  });
}

export function useProjectOverview(projectId: string | null) {
  return useQuery({
    queryKey: researchKeys.overview(projectId ?? ''),
    queryFn: () => apiRequest<ProjectOverviewDto>(`/api/projects/${projectId}/overview`),
    enabled: Boolean(projectId),
  });
}

/**
 * Related files are fetched only when the details panel asks for them: it is an extra
 * query per file opened, and most of the time the answer is "nothing related".
 */
export function useRelatedFiles(fileId: string | null, enabled = true) {
  return useQuery({
    queryKey: researchKeys.related(fileId ?? ''),
    queryFn: () => apiRequest<RelatedFileDto[]>(`/api/files/${fileId}/related`),
    enabled: Boolean(fileId) && enabled,
  });
}

function useExperimentMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['experiments'] });
      void queryClient.invalidateQueries({ queryKey: ['experiment'] });
      void queryClient.invalidateQueries({ queryKey: ['project-overview'] });
    },
  });
}

export interface ExperimentInput {
  code: string;
  title: string;
  objective?: string;
  status?: string;
  outcome?: string;
  outcomeSummary?: string;
  protocolRef?: string;
  instrumentRef?: string;
  organism?: string;
  sampleIds?: string[];
  startedOn?: string | null;
  completedOn?: string | null;
  tags?: string[];
}

export function useCreateExperiment() {
  return useExperimentMutation((input: ExperimentInput & { projectId: string }) =>
    apiRequest<ExperimentDto>('/api/experiments', { method: 'POST', body: input }),
  );
}

export function useUpdateExperiment() {
  return useExperimentMutation(
    (input: Partial<ExperimentInput> & { experimentId: string }) => {
      const { experimentId, ...body } = input;
      return apiRequest<ExperimentDto>(`/api/experiments/${experimentId}`, {
        method: 'PATCH',
        body,
      });
    },
  );
}

export function useArchiveExperiment() {
  return useExperimentMutation((experimentId: string) =>
    apiRequest<void>(`/api/experiments/${experimentId}`, { method: 'DELETE' }),
  );
}

/* ------------------------------------------------------------------ templates */

export interface FolderTemplateDto {
  project: Array<{ key: string; name: string; description: string }>;
  department: Array<{ key: string; name: string; description: string }>;
  customized: boolean;
}

export interface MetadataTemplateDto {
  templates: Array<{
    key: string;
    label: string;
    description: string;
    fieldKeys: string[];
    recommendedKeys?: string[];
  }>;
  fields: Array<{ key: string; label: string; type: string; hint?: string }>;
  customized: boolean;
}

export function useFolderTemplates() {
  return useQuery({
    queryKey: ['templates', 'folders'],
    queryFn: () => apiRequest<FolderTemplateDto>('/api/admin/templates/folders'),
  });
}

export function useMetadataTemplates() {
  return useQuery({
    queryKey: ['templates', 'metadata'],
    queryFn: () => apiRequest<MetadataTemplateDto>('/api/admin/templates/metadata'),
  });
}

function useTemplateMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
      void queryClient.invalidateQueries({ queryKey: ['metadata-templates'] });
    },
  });
}

export function useSaveFolderTemplates() {
  return useTemplateMutation(
    (body: { project?: Array<{ key?: string; name: string; description?: string }> }) =>
      apiRequest<FolderTemplateDto>('/api/admin/templates/folders', { method: 'PUT', body }),
  );
}

export function useSaveMetadataTemplates() {
  return useTemplateMutation((body: MetadataTemplateDto['templates']) =>
    apiRequest<MetadataTemplateDto>('/api/admin/templates/metadata', {
      method: 'PUT',
      body: { templates: body },
    }),
  );
}
