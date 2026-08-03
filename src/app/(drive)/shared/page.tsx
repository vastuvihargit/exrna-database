import type { Metadata } from 'next';

import { SharedWithMeView } from '@/components/drive/shared-with-me-view';

export const metadata: Metadata = { title: 'Shared with me' };

export default function SharedPage() {
  return <SharedWithMeView />;
}
