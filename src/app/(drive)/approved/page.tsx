import type { Metadata } from 'next';

import { ApprovedFilesView } from '@/components/review/approved-files-view';

export const metadata: Metadata = { title: 'Approved files' };

export default function ApprovedPage() {
  return <ApprovedFilesView />;
}
