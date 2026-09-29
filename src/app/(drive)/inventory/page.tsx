import type { Metadata } from 'next';

import { InventoryDashboard } from '@/components/inventory/dashboard';

export const metadata: Metadata = { title: 'Inventory' };

/**
 * The inventory landing page.
 *
 * Was a redirect to the item list while stock movement did not exist and there was nothing to
 * summarize. Now that receipts, issues and adjustments are recorded, the four counts a store
 * manager checks first are worth their own page.
 */
export default function InventoryPage() {
  return <InventoryDashboard />;
}
