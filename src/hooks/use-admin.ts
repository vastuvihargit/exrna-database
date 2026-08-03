'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  jobTitle: string | null;
  departmentId: string | null;
  status: 'invited' | 'active' | 'suspended' | 'deactivated';
  isSuperAdmin: boolean;
  roles: Array<{ grantId: string; roleKey: string; roleName: string; scopeType: string; scopeId: string | null }>;
  storageQuotaBytes: number;
  storageUsedBytes: number;
  lastLoginAt: string | null;
  createdAt: string;
  mfaEnabled: boolean;
  authProviders: string[];
}

export interface Department {
  id: string;
  name: string;
  code: string;
  description: string;
  headUserId: string | null;
  storageQuotaBytes: number;
  storageUsedBytes: number;
  memberCount: number;
  isActive: boolean;
}

export interface RoleOption {
  id: string;
  key: string;
  name: string;
  description: string;
  rank: number;
  scopeTypes: string[];
  permissions: string[];
  isSystem: boolean;
}

export interface AuditEntry {
  id: string;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  previousValue: unknown;
  newValue: unknown;
  reason: string | null;
  ip: string;
  outcome: string;
  severity: string;
  createdAt: string;
}

interface Paged<T> {
  items: T[];
  total: number;
}

/**
 * The API returns `{data, meta}`; apiRequest unwraps `data`, so paged endpoints are
 * fetched through a small wrapper that keeps the total.
 */
async function fetchPaged<T>(path: string): Promise<Paged<T>> {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
  const body = (await response.json()) as {
    data?: T[];
    meta?: { total: number };
    error?: { message: string };
  };
  if (!response.ok || body.error) throw new Error(body.error?.message ?? 'Request failed');
  return { items: body.data ?? [], total: body.meta?.total ?? 0 };
}

export interface UserQuery {
  search?: string;
  status?: string;
  departmentId?: string;
  page: number;
  pageSize: number;
}

export function useAdminUsers(query: UserQuery) {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.search) params.set('search', query.search);
  if (query.status && query.status !== 'all') params.set('status', query.status);
  if (query.departmentId && query.departmentId !== 'all') params.set('departmentId', query.departmentId);

  return useQuery({
    queryKey: ['admin', 'users', query],
    queryFn: () => fetchPaged<AdminUser>(`/api/admin/users?${params.toString()}`),
    placeholderData: (previous) => previous,
  });
}

export function useDepartments() {
  return useQuery({
    queryKey: ['departments'],
    queryFn: () => apiRequest<Department[]>('/api/departments'),
    staleTime: 5 * 60_000,
  });
}

export function useRoles() {
  return useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: () => apiRequest<RoleOption[]>('/api/admin/roles'),
    staleTime: 10 * 60_000,
  });
}

export function useAuditLogs(query: { page: number; pageSize: number; action?: string; outcome?: string }) {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
  if (query.action && query.action !== 'all') params.set('action', query.action);
  if (query.outcome && query.outcome !== 'all') params.set('outcome', query.outcome);

  return useQuery({
    queryKey: ['admin', 'audit', query],
    queryFn: () => fetchPaged<AuditEntry>(`/api/admin/audit-logs?${params.toString()}`),
    placeholderData: (previous) => previous,
  });
}

function useInvalidateUsers() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    void queryClient.invalidateQueries({ queryKey: ['departments'] });
  };
}

export function useCreateUser() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<AdminUser>('/api/admin/users', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useSetUserStatus() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (input: { userId: string; status: string; reason?: string | null }) =>
      apiRequest<AdminUser>(`/api/admin/users/${input.userId}/status`, {
        method: 'POST',
        body: { status: input.status, reason: input.reason ?? null },
      }),
    onSuccess: invalidate,
  });
}

export function useGrantRole() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (input: { userId: string; roleKey: string; scopeType: string; scopeId: string | null }) =>
      apiRequest<AdminUser>(`/api/admin/users/${input.userId}/roles`, {
        method: 'POST',
        body: { roleKey: input.roleKey, scopeType: input.scopeType, scopeId: input.scopeId },
      }),
    onSuccess: invalidate,
  });
}

export function useRevokeRole() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (input: { userId: string; grantId: string }) =>
      apiRequest<AdminUser>(`/api/admin/users/${input.userId}/roles`, {
        method: 'DELETE',
        body: { grantId: input.grantId },
      }),
    onSuccess: invalidate,
  });
}

export function useCreateDepartment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<Department>('/api/departments', { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['departments'] }),
  });
}
