'use client';

import * as React from 'react';
import Link from 'next/link';
import { Package, Plus, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { hasPermission, useSession } from '@/hooks/use-session';
import { useDepartments } from '@/hooks/use-admin';
import {
  useInventoryItems,
  type InventoryItemDto,
  type StockFilter,
} from '@/hooks/use-inventory';
import { ItemDialog } from './item-dialog';
import {
  ExpiryStateBadge,
  ItemStatusBadge,
  StockStateBadge,
  formatDate,
  formatQuantity,
} from './stock-badges';

const PAGE_SIZE = 25;

const CATEGORY_OPTIONS = [
  { value: 'all', label: 'All categories' },
  { value: 'chemical', label: 'Chemicals' },
  { value: 'reagent', label: 'Reagents' },
  { value: 'consumable', label: 'Consumables' },
  { value: 'glassware', label: 'Glassware' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'other', label: 'Other' },
];

const STOCK_FILTERS: Array<{ value: StockFilter | 'all'; label: string }> = [
  { value: 'all', label: 'Everything' },
  { value: 'available', label: 'Available' },
  { value: 'low', label: 'Low stock' },
  { value: 'out_of_stock', label: 'Out of stock' },
  { value: 'near_expiry', label: 'Near expiry' },
  { value: 'expired', label: 'Expired' },
];

/**
 * The item catalogue.
 *
 * Search runs on the server rather than over a page of results: filtering client-side would
 * search only the 25 rows already fetched, which looks like it works right up until the
 * store has more than a page of items in it.
 */
export function ItemList() {
  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [category, setCategory] = React.useState('all');
  const [stockFilter, setStockFilter] = React.useState<StockFilter | 'all'>('all');
  const [departmentId, setDepartmentId] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const [editing, setEditing] = React.useState<InventoryItemDto | null>(null);
  const [creating, setCreating] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: session } = useSession();
  const { data: departments } = useDepartments();
  const { data, isPending, isError, error } = useInventoryItems({
    q: debouncedSearch || undefined,
    category,
    stockFilter,
    departmentId,
    page,
    pageSize: PAGE_SIZE,
  });

  const items = data ?? [];

  // The session permission is the union across every grant and says nothing about scope, so
  // it can be true for somebody who may only manage one department's items. That is the
  // right way round: the button is offered, and the server decides when the department is
  // actually chosen. A refusal is a clear message; a hidden button is a dead end nobody can
  // diagnose.
  const canCreate =
    hasPermission(session, 'inventory.item.manage') ||
    items.some((item) => item.capabilities.edit);

  const filtersApplied =
    Boolean(debouncedSearch) || category !== 'all' || stockFilter !== 'all' || departmentId !== 'all';

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Package className="size-4" aria-hidden="true" />
            Inventory items
          </CardTitle>
          <CardDescription>
            Everything the laboratory keeps in stock. Quantities move through receipts, issues
            and corrections — each one leaves a history entry.
          </CardDescription>
        </div>
        {canCreate ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-2 size-3.5" aria-hidden="true" />
            New item
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-56 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, code, batch, supplier or location"
              className="h-9 pl-8"
              aria-label="Search inventory"
            />
          </div>

          <Select
            value={category}
            onValueChange={(value) => {
              setCategory(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-9 w-44" aria-label="Filter by category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={departmentId}
            onValueChange={(value) => {
              setDepartmentId(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-9 w-44" aria-label="Filter by department">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All locations</SelectItem>
              {(departments ?? []).map((department) => (
                <SelectItem key={department.id} value={department.id}>
                  {department.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap gap-1" role="group" aria-label="Stock filters">
          {STOCK_FILTERS.map((filter) => (
            <Button
              key={filter.value}
              type="button"
              size="sm"
              variant={stockFilter === filter.value ? 'default' : 'outline'}
              className="h-7 text-xs"
              aria-pressed={stockFilter === filter.value}
              onClick={() => {
                setStockFilter(filter.value);
                setPage(1);
              }}
            >
              {filter.label}
            </Button>
          ))}
        </div>

        {isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : isError ? (
          <p className="rounded-md border border-dashed p-8 text-center text-sm text-destructive">
            {error instanceof Error ? error.message : 'Could not load the inventory.'}
          </p>
        ) : items.length === 0 ? (
          <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            {filtersApplied
              ? 'No item matches those filters.'
              : 'No inventory items yet. Add one to start tracking stock.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead>Expiry</TableHead>
                  <TableHead>Location</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id} className={cn(item.status !== 'active' && 'opacity-60')}>
                    <TableCell>
                      <Link
                        href={`/inventory/items/${item.id}`}
                        className="font-medium hover:underline"
                      >
                        {item.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {item.code}
                        {item.departmentName ? ` · ${item.departmentName}` : ' · Central store'}
                      </p>
                    </TableCell>
                    <TableCell className="text-sm capitalize">{item.category}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {formatQuantity(item.availableQuantity, item.unit)}
                      {item.minimumStock > 0 ? (
                        <span className="block text-xs text-muted-foreground">
                          min {formatQuantity(item.minimumStock, item.unit)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <StockStateBadge state={item.stockState} />
                        <ItemStatusBadge status={item.status} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <ExpiryStateBadge state={item.expiryState} />
                        <span className="text-xs text-muted-foreground">
                          {formatDate(item.expiryDate)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {item.storageLocation || '—'}
                      {item.capabilities.edit ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-2 h-6 text-xs"
                          onClick={() => setEditing(item)}
                        >
                          Edit
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {items.length > 0 ? (
          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-muted-foreground">
              Page {page}
              {items.length === PAGE_SIZE ? '' : ' — end of results'}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={items.length < PAGE_SIZE}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>

      <ItemDialog
        item={editing}
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      />
    </Card>
  );
}
