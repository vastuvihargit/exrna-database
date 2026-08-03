'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  departmentId: string | null;
  projectIds: string[];
  isSuperAdmin: boolean;
}

export interface SessionData {
  user: SessionUser;
  roles: Array<{ key: string; name: string; scopeType: string; scopeId: string | null }>;
  /** Rendering hints only — the server re-derives permission on every request. */
  permissions: string[];
  storage: { usedBytes: number; quotaBytes: number };
}

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: () => apiRequest<SessionData>('/api/auth/session'),
    staleTime: 60_000,
    // 401 means "signed out", which is an answer, not a failure worth retrying.
    retry: false,
  });
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (scope: 'this' | 'all' = 'this') =>
      apiRequest(scope === 'all' ? '/api/auth/logout-all' : '/api/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      queryClient.clear();
      window.location.href = '/login';
    },
  });
}

export function hasPermission(session: SessionData | undefined, permission: string): boolean {
  if (!session) return false;
  return session.user.isSuperAdmin || session.permissions.includes(permission);
}
