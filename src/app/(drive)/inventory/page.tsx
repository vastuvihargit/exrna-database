import { redirect } from 'next/navigation';

/**
 * The inventory landing page.
 *
 * Phase 1 has one section, so `/inventory` goes straight to it rather than showing a page
 * with a single link on it. Phase 3 replaces this with the dashboard.
 */
export default function InventoryPage() {
  redirect('/inventory/items');
}
