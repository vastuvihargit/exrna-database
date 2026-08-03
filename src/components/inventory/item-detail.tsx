'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, Package } from 'lucide-react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/utils';
import {
  useDeactivateInventoryItem,
  useInventoryItem,
  type InventoryItemDto,
} from '@/hooks/use-inventory';
import { ItemDialog } from './item-dialog';
import {
  ExpiryStateBadge,
  ItemStatusBadge,
  StockStateBadge,
  formatDate,
  formatQuantity,
} from './stock-badges';

/**
 * One item: what it is, and what is actually on the shelf.
 *
 * The batch table is the substance of this page. An item that reads "500 mL available" is
 * not the same thing as one batch of 500 mL expiring on Friday, and a store manager about
 * to hand it over needs to see which of those it is.
 */
export function ItemDetail({ itemId }: { itemId: string }) {
  const { data: item, isPending, isError, error } = useInventoryItem(itemId);
  const [editing, setEditing] = React.useState(false);
  const [confirmingRemove, setConfirmingRemove] = React.useState(false);

  if (isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (isError || !item) {
    return (
      <div className="space-y-4">
        <BackLink />
        <p className="rounded-md border border-dashed p-8 text-center text-sm text-destructive">
          {error instanceof ApiError && error.status === 404
            ? 'That item does not exist, or you cannot see it.'
            : error instanceof Error
              ? error.message
              : 'Could not load the item.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Package className="size-5" aria-hidden="true" />
            {item.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {item.code} · {item.category} ·{' '}
            {item.departmentName ? item.departmentName : 'Central store'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StockStateBadge state={item.stockState} />
          <ExpiryStateBadge state={item.expiryState} />
          <ItemStatusBadge status={item.status} />
          {item.capabilities.edit ? (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Stock</CardTitle>
          <CardDescription>
            {formatQuantity(item.availableQuantity, item.unit)} available
            {item.minimumStock > 0
              ? `, reorder at ${formatQuantity(item.minimumStock, item.unit)}`
              : ''}
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Detail label="Default location" value={item.storageLocation || '—'} />
            <Detail label="Supplier" value={item.supplier || '—'} />
            <Detail label="Unit" value={item.unit} />
            <Detail label="Next batch out" value={item.batchNumber || '—'} />
            <Detail label="Earliest expiry" value={formatDate(item.expiryDate)} />
            <Detail label="Last updated" value={formatRelativeTime(item.updatedAt)} />
          </dl>

          {item.description ? (
            <p className="mt-4 whitespace-pre-wrap border-t pt-4 text-sm text-muted-foreground">
              {item.description}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Batches</CardTitle>
          <CardDescription>
            What is physically in stock. Issued first-expiry-first, so the batch at the top is
            the one to hand over next.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {item.batches.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              Nothing in stock. Record a receipt when a delivery arrives.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Received</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...item.batches]
                    .sort(compareByExpiry)
                    .map((batch) => (
                      <TableRow key={batch.batchNumber}>
                        <TableCell className="font-medium">{batch.batchNumber}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatQuantity(batch.quantity, item.unit)}
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(batch.expiryDate)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {batch.supplier || '—'}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {batch.storageLocation || item.storageLocation || '—'}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatRelativeTime(batch.receivedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {item.capabilities.edit ? (
        <RemoveItemCard
          item={item}
          open={confirmingRemove}
          onOpenChange={setConfirmingRemove}
        />
      ) : null}

      <ItemDialog item={editing ? item : null} open={editing} onOpenChange={setEditing} />
    </div>
  );
}

function compareByExpiry(
  a: InventoryItemDto['batches'][number],
  b: InventoryItemDto['batches'][number],
): number {
  // Undated batches sort last: they are the ones with no deadline attached.
  if (!a.expiryDate && !b.expiryDate) return a.batchNumber.localeCompare(b.batchNumber);
  if (!a.expiryDate) return 1;
  if (!b.expiryDate) return -1;
  return new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime();
}

function BackLink() {
  return (
    <Link
      href="/inventory/items"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      All items
    </Link>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}

function RemoveItemCard({
  item,
  open,
  onOpenChange,
}: {
  item: InventoryItemDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deactivate = useDeactivateInventoryItem();
  const blocked = item.availableQuantity > 0;

  return (
    <Card className="border-destructive/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Remove this item</CardTitle>
        <CardDescription>
          {blocked
            ? `${item.code} still holds ${formatQuantity(item.availableQuantity, item.unit)}. Issue or write off the remaining stock first — material on a shelf with no record of it is what this system exists to prevent.`
            : 'Takes it out of the catalogue. Its stock history is kept and stays readable.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={blocked || deactivate.isPending}
          onClick={() => onOpenChange(true)}
        >
          Remove item
        </Button>
      </CardContent>

      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {item.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              {item.name} will no longer appear in the catalogue. Every receipt and issue
              recorded against it stays in the stock history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                try {
                  await deactivate.mutateAsync(item.id);
                  toast.success(`${item.code} removed`);
                  window.location.href = '/inventory/items';
                } catch (error) {
                  toast.error(
                    error instanceof ApiError ? error.message : 'Could not remove the item',
                  );
                }
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
