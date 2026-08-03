import type { Metadata } from 'next';

import { ItemDetail } from '@/components/inventory/item-detail';

export const metadata: Metadata = { title: 'Inventory item' };

export default async function InventoryItemPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;
  return <ItemDetail itemId={itemId} />;
}
