'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type { FileDto } from './use-files';
import type { FolderDto } from './use-drive';

/**
 * Search criteria as the URL carries them.
 *
 * Everything is a string, deliberately: this object is both the query-string source and
 * what gets stored in a saved search, and keeping one representation means a saved
 * search is exactly the URL that produced it.
 */
export type SearchCriteria = Record<string, string>;

export interface SearchResponse {
  files: FileDto[];
  folders: FolderDto[];
  empty: boolean;
}

export interface SearchFacets {
  categories: Array<{ value: string; count: number }>;
  tags: Array<{ value: string; count: number }>;
}

export interface SavedSearchDto {
  id: string;
  name: string;
  criteria: SearchCriteria;
  isPinned: boolean;
  lastRunAt: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MetadataFieldDto {
  key: string;
  label: string;
  type: 'text' | 'longtext' | 'date' | 'number' | 'select' | 'list';
  hint?: string;
  options?: string[];
  maxLength?: number;
  min?: number;
  max?: number;
  maxItems?: number;
}

export interface MetadataTemplateDto {
  key: string;
  label: string;
  description: string;
  fieldKeys: string[];
  recommendedKeys?: string[];
}

export function criteriaToQueryString(criteria: SearchCriteria): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(criteria)) {
    if (value !== '' && value != null) params.set(key, value);
  }
  return params.toString();
}

export const searchKeys = {
  results: (criteria: SearchCriteria) => ['search', criteriaToQueryString(criteria)] as const,
  facets: () => ['search', 'facets'] as const,
  saved: () => ['search', 'saved'] as const,
  metadata: () => ['metadata', 'templates'] as const,
};

export function useSearch(criteria: SearchCriteria, enabled = true) {
  const queryString = criteriaToQueryString(criteria);
  return useQuery({
    queryKey: searchKeys.results(criteria),
    queryFn: () => apiRequest<SearchResponse>(`/api/search?${queryString}`),
    enabled: enabled && queryString.length > 0,
    // Search is read-mostly and a researcher refines a query in bursts; a short window
    // keeps back-and-forth instant without ever showing a stale permission decision.
    staleTime: 15_000,
  });
}

export function useSearchFacets() {
  return useQuery({
    queryKey: searchKeys.facets(),
    queryFn: () => apiRequest<SearchFacets>('/api/search/facets'),
    staleTime: 60_000,
  });
}

export function useMetadataTemplates() {
  return useQuery({
    queryKey: searchKeys.metadata(),
    queryFn: () =>
      apiRequest<{
        fields: MetadataFieldDto[];
        templates: MetadataTemplateDto[];
        suggested: string | null;
      }>('/api/metadata/templates'),
    // The field definitions are code, not data — they only change on deploy.
    staleTime: Infinity,
  });
}

export function useSavedSearches() {
  return useQuery({
    queryKey: searchKeys.saved(),
    queryFn: () => apiRequest<SavedSearchDto[]>('/api/search/saved'),
  });
}

function useSavedSearchMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: searchKeys.saved() });
    },
  });
}

export function useSaveSearch() {
  return useSavedSearchMutation((input: { name: string; criteria: SearchCriteria; isPinned?: boolean }) =>
    apiRequest<SavedSearchDto>('/api/search/saved', { method: 'POST', body: input }),
  );
}

export function useUpdateSavedSearch() {
  return useSavedSearchMutation((input: { id: string; name?: string; isPinned?: boolean }) => {
    const { id, ...body } = input;
    return apiRequest<SavedSearchDto>(`/api/search/saved/${id}`, { method: 'PATCH', body });
  });
}

export function useDeleteSavedSearch() {
  return useSavedSearchMutation((id: string) =>
    apiRequest<void>(`/api/search/saved/${id}`, { method: 'DELETE' }),
  );
}
