import type { Metadata } from 'next';

import { TrashView } from '@/components/drive/lifecycle-views';

export const metadata: Metadata = { title: 'Trash' };

export default function TrashPage() {
  return <TrashView />;
}
