'use client';

import { Badge } from '@/components/ui/badge';
import type { ExpiryState, InventoryItemStatus, StockState } from '@/hooks/use-inventory';

/**
 * The two badges that say whether an item needs attention.
 *
 * They are deliberately separate: an item can be well stocked and about to expire, or
 * nearly empty and perfectly fresh, and collapsing that into one status would hide whichever
 * problem lost the tie.
 *
 * Each badge carries a word as well as a colour — colour alone is not information for a
 * reader who cannot distinguish amber from red.
 */

const STOCK_LABEL: Record<StockState, string> = {
  ok: 'In stock',
  low: 'Low stock',
  out_of_stock: 'Out of stock',
};

const STOCK_VARIANT: Record<StockState, 'success' | 'warning' | 'destructive'> = {
  ok: 'success',
  low: 'warning',
  out_of_stock: 'destructive',
};

export function StockStateBadge({ state }: { state: StockState }) {
  return <Badge variant={STOCK_VARIANT[state]}>{STOCK_LABEL[state]}</Badge>;
}

const EXPIRY_LABEL: Record<Exclude<ExpiryState, 'none'>, string> = {
  ok: 'In date',
  near_expiry: 'Near expiry',
  expired: 'Expired',
};

const EXPIRY_VARIANT: Record<Exclude<ExpiryState, 'none'>, 'outline' | 'warning' | 'destructive'> = {
  ok: 'outline',
  near_expiry: 'warning',
  expired: 'destructive',
};

/** Renders nothing when the item has no dated stock — there is no news to report. */
export function ExpiryStateBadge({ state }: { state: ExpiryState }) {
  if (state === 'none') return null;
  return <Badge variant={EXPIRY_VARIANT[state]}>{EXPIRY_LABEL[state]}</Badge>;
}

const STATUS_LABEL: Record<InventoryItemStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  discontinued: 'Discontinued',
};

/** Only shown when it is not `active`, which is the unremarkable case. */
export function ItemStatusBadge({ status }: { status: InventoryItemStatus }) {
  if (status === 'active') return null;
  return <Badge variant="secondary">{STATUS_LABEL[status]}</Badge>;
}

/** A quantity is meaningless without its unit, so they are formatted together, always. */
export function formatQuantity(quantity: number, unit: string): string {
  const rounded = Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(3).replace(/0+$/, '');
  return `${rounded} ${unit}`;
}

export function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
