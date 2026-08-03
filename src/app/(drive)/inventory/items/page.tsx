import type { Metadata } from 'next';

import { ItemList } from '@/components/inventory/item-list';

export const metadata: Metadata = { title: 'Inventory items' };

export default function InventoryItemsPage() {
  return <ItemList />;
}
