import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { requireActor } from '@/server/http/page-guard';

/**
 * Inventory area.
 *
 * The guard runs server-side on every render. Hiding the sidebar entry is a convenience;
 * this redirect is the control — and every API route underneath re-checks independently,
 * because a page guard protects a page, not the data behind it.
 *
 * `inventory.view` is checked at any scope rather than at company scope only: a department
 * store manager holds it against their own department and must still be able to open the
 * area. Which *items* they can change is decided per item, not here.
 */
export const dynamic = 'force-dynamic';

const INVENTORY_TABS = [
  { href: '/inventory', label: 'Overview' },
  { href: '/inventory/items', label: 'Items' },
];

export default async function InventoryLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor('/inventory');

  const allowed =
    actor.isSuperAdmin ||
    actor.grants.some((grant) => grant.permissions.includes('inventory.view'));

  if (!allowed) redirect('/access-denied?reason=permission');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Chemicals, reagents and consumables — what is in stock, and where it went.
        </p>
      </div>

      <nav aria-label="Inventory sections" className="flex flex-wrap gap-1 border-b">
        {INVENTORY_TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="rounded-t-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {children}
    </div>
  );
}
