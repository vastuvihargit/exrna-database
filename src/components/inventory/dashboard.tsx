'use client';

import Link from 'next/link';
import { AlertTriangle, CalendarClock, PackageX, Boxes } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useInventoryDashboard } from '@/hooks/use-inventory';

/**
 * The four things a store manager checks before doing anything else.
 *
 * Each tile links straight into the item list with the matching filter applied, because a count
 * with no way to reach the rows behind it is a number to worry about rather than act on.
 *
 * The counts come from one request. Fetching them as four filtered listings read for their
 * totals would let a receipt land between two of them, and the tiles would not add up.
 */
export function InventoryDashboard() {
  const { data, isPending, isError } = useInventoryDashboard();

  if (isError) {
    return (
      <p className="rounded-md border border-dashed p-8 text-center text-sm text-destructive">
        Could not load the inventory summary.
      </p>
    );
  }

  const tiles = [
    {
      href: '/inventory/items',
      label: 'Items in the catalogue',
      value: data?.totalItems,
      icon: Boxes,
      tone: 'text-muted-foreground',
      hint: 'Everything currently stocked or listed.',
    },
    {
      href: '/inventory/items?stockFilter=low',
      label: 'Low stock',
      value: data?.byStockState.low,
      icon: AlertTriangle,
      tone: 'text-amber-600 dark:text-amber-500',
      hint: 'At or below the reorder level.',
    },
    {
      href: '/inventory/items?stockFilter=out_of_stock',
      label: 'Out of stock',
      value: data?.byStockState.out_of_stock,
      icon: PackageX,
      tone: 'text-destructive',
      hint: 'Nothing left on the shelf.',
    },
    {
      href: '/inventory/items?stockFilter=near_expiry',
      label: 'Near expiry',
      value: data?.nearExpiry,
      icon: CalendarClock,
      tone: 'text-amber-600 dark:text-amber-500',
      hint: 'Expiring within 30 days — use these first.',
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <Link key={tile.href} href={tile.href} className="rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Card className="h-full transition-colors hover:bg-muted/40">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{tile.label}</CardTitle>
                <tile.icon className={`size-4 ${tile.tone}`} aria-hidden="true" />
              </CardHeader>
              <CardContent>
                {isPending ? (
                  <Skeleton className="h-8 w-16" />
                ) : (
                  <p className="text-2xl font-semibold tabular-nums">{tile.value ?? 0}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">{tile.hint}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/*
        Expired stock is separated from the tiles above rather than being a fifth one. It is not
        a level to watch — it is material sitting on a shelf that cannot lawfully be used, and it
        stays counted in the item's total until somebody writes it off. Showing it only when it
        exists keeps the page quiet on the normal day.
      */}
      {!isPending && (data?.expired ?? 0) > 0 ? (
        <Card className="border-destructive/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-destructive">
              {data!.expired} item{data!.expired === 1 ? '' : 's'} hold expired stock
            </CardTitle>
            <CardDescription>
              Expired batches cannot be issued, but they are still counted in the quantity on
              screen. Write them off with a stock adjustment so the figure matches the shelf.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/inventory/items?stockFilter=expired"
              className="text-sm font-medium underline underline-offset-4"
            >
              Show them
            </Link>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
