import type { Metadata } from 'next';

import { ArchiveView } from '@/components/drive/lifecycle-views';

export const metadata: Metadata = { title: 'Archive' };

export default function ArchivePage() {
  return <ArchiveView />;
}
