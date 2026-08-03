'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type { FileDto } from './use-files';

export type ReviewDecision = 'approve' | 'reject' | 'request_changes';
export type ReviewStatus = 'pending' | 'changes_requested' | 'approved' | 'rejected' | 'cancelled';

export interface ReviewDto {
  id: string;
  fileId: string;
  fileName: string;
  versionId: string;
  versionNumber: number;
  /** Lets a reader verify the approved bytes are the bytes still on disk. */
  versionChecksum: string;
  requestedBy: string;
  requestedByName: string;
  requestNote: string;
  reviewerUserIds: string[];
  requiredApprovals: number;
  approvalsSoFar: number;
  status: ReviewStatus;
  dueAt: string | null;
  closedAt: string | null;
  createdAt: string;
  capabilities: { canDecide: boolean; canCancel: boolean };
  decisions: Array<{
    reviewerUserId: string;
    reviewerName: string;
    decision: ReviewDecision;
    comment: string;
    decidedAt: string;
  }>;
}

export const reviewKeys = {
  list: (scope: 'assigned' | 'submitted') => ['reviews', scope] as const,
  forFile: (fileId: string) => ['reviews', 'file', fileId] as const,
  approved: () => ['approved-files'] as const,
};

export function useReviews(scope: 'assigned' | 'submitted' = 'assigned') {
  return useQuery({
    queryKey: reviewKeys.list(scope),
    queryFn: () => apiRequest<ReviewDto[]>(`/api/reviews?scope=${scope}`),
  });
}

export function useFileReviews(fileId: string | null) {
  return useQuery({
    queryKey: reviewKeys.forFile(fileId ?? ''),
    queryFn: () => apiRequest<ReviewDto[]>(`/api/files/${fileId}/reviews`),
    enabled: Boolean(fileId),
  });
}

export function useApprovedFiles() {
  return useQuery({
    queryKey: reviewKeys.approved(),
    queryFn: () => apiRequest<{ files: FileDto[] }>('/api/approved?pageSize=50'),
  });
}

/**
 * A decision changes the file's approval badge, its version labels and two dashboards,
 * so everything file-shaped is refetched rather than surgically patched.
 */
function useReviewMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['approved-files'] });
      void queryClient.invalidateQueries({ queryKey: ['file'] });
      void queryClient.invalidateQueries({ queryKey: ['folder'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
    },
  });
}

export function useSubmitForReview() {
  return useReviewMutation(
    (input: {
      fileId: string;
      reviewerUserIds: string[];
      note?: string;
      requiredApprovals?: number;
      versionId?: string;
    }) => {
      const { fileId, ...body } = input;
      return apiRequest<ReviewDto>(`/api/files/${fileId}/reviews`, { method: 'POST', body });
    },
  );
}

export function useDecideReview() {
  return useReviewMutation(
    (input: { reviewId: string; decision: ReviewDecision; comment?: string }) => {
      const { reviewId, ...body } = input;
      return apiRequest<ReviewDto>(`/api/reviews/${reviewId}/decision`, { method: 'POST', body });
    },
  );
}

export function useCancelReview() {
  return useReviewMutation((reviewId: string) =>
    apiRequest<void>(`/api/reviews/${reviewId}`, { method: 'DELETE' }),
  );
}
