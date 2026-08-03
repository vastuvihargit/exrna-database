import type { Metadata } from 'next';

import { MyDriveView } from '@/components/drive/drive-views';

export const metadata: Metadata = { title: 'My Drive' };

export default function MyDrivePage() {
  return <MyDriveView />;
}
