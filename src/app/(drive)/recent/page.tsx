import type { Metadata } from 'next';

import { RecentView } from '@/components/drive/lifecycle-views';

export const metadata: Metadata = { title: 'Recent' };

export default function RecentPage() {
  return <RecentView />;
}
