import type { Metadata } from 'next';

import { StarredView } from '@/components/drive/lifecycle-views';

export const metadata: Metadata = { title: 'Starred' };

export default function StarredPage() {
  return <StarredView />;
}
