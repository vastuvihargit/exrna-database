'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';

export type InventoryCategory =
  | 'chemical'
  | 'reagent'
  | 'consumable'
  | 'glassware'
  | 'equipment'
  | 'other';

export type InventoryUnit =
  | 'mg'
  | 'g'
  | 'kg'
  | 'µL'
  | 'mL'
  | 'L'
  | 'units'
  | 'vials'
  | 'tubes'
  | 'plates'
  | 'boxes'
  | 'packs'
  | 'rolls'
  | 'other';

export type InventoryItemStatus = 'active' | 'inactive' | 'discontinued';
export type StockState = 'ok' | 'low' | 'out_of_stock';
export type ExpiryState = 'none' | 'ok' | 'near_expiry' | 'expired';
export type StockFilter = 'available' | 'low' | 'out_of_stock' | 'near_expiry' | 'expired';

export interface InventoryBatchDto {
  batchNumber: string;
  quantity: number;
  expiryDate: string | null;
  supplier: string;
  storageLocation: string;
  receivedAt: string;
}

/** Mirrors `toInventoryItemDto`. */
export interface InventoryItemDto {
  id: string;
  departmentId: string | null;
  departmentName: string | null;
  name: string;
  code: string;
  category: InventoryCategory;
  unit: InventoryUnit;
  description: string;
  availableQuantity: number;
  minimumStock: number;
  stockState: StockState;
  expiryState: ExpiryState;
  batches: InventoryBatchDto[];
  batchNumber: string;
  expiryDate: string | null;
  storageLocation: string;
  supplier: string;
  status: InventoryItemStatus;
  documentFileIds: string[];
  capabilities: {
    edit: boolean;
    addStock: boolean;
    issueStock: boolean;
    adjustStock: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface InventoryItemsQuery {
  q?: string;
  category?: string;
  status?: string;
  departmentId?: string;
  stockFilter?: string;
  sort?: string;
  order?: string;
  page?: number;
  pageSize?: number;
}

export const inventoryKeys = {
  items: (query: InventoryItemsQuery) => ['inventory-items', query] as const,
  item: (id: string) => ['inventory-item', id] as const,
};

/**
 * The list endpoint returns `meta.total`, which the envelope carries alongside `data`.
 * `apiRequest` unwraps `data`, so the count is fetched here in its own shape rather than
 * threaded through it — the alternative is a second generic on every call site.
 */
export function useInventoryItems(query: InventoryItemsQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    // "all" is the UI's word for "no filter" — it must not reach the API, whose schemas
    // reject anything outside their enums.
    if (value === undefined || value === '' || value === 'all') continue;
    params.set(key, String(value));
  }

  return useQuery({
    queryKey: inventoryKeys.items(query),
    queryFn: () => apiRequest<InventoryItemDto[]>(`/api/inventory/items?${params.toString()}`),
    placeholderData: (previous) => previous,
  });
}

export function useInventoryItem(itemId: string | null) {
  return useQuery({
    queryKey: inventoryKeys.item(itemId ?? ''),
    queryFn: () => apiRequest<InventoryItemDto>(`/api/inventory/items/${itemId}`),
    enabled: Boolean(itemId),
  });
}

function useInventoryMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory-items'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory-item'] });
    },
  });
}

export interface InventoryItemInput {
  name: string;
  category: InventoryCategory;
  unit: InventoryUnit;
  departmentId?: string | null;
  description?: string;
  minimumStock?: number;
  storageLocation?: string;
  supplier?: string;
  status?: InventoryItemStatus;
}

export function useCreateInventoryItem() {
  return useInventoryMutation((input: InventoryItemInput & { code: string }) =>
    apiRequest<InventoryItemDto>('/api/inventory/items', { method: 'POST', body: input }),
  );
}

export function useUpdateInventoryItem() {
  return useInventoryMutation((input: Partial<InventoryItemInput> & { itemId: string }) => {
    const { itemId, ...body } = input;
    return apiRequest<InventoryItemDto>(`/api/inventory/items/${itemId}`, {
      method: 'PATCH',
      body,
    });
  });
}

export function useDeactivateInventoryItem() {
  return useInventoryMutation((itemId: string) =>
    apiRequest<void>(`/api/inventory/items/${itemId}`, { method: 'DELETE' }),
  );
}
