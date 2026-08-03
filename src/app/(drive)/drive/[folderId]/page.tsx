import type { Metadata } from 'next';

import { FolderView } from '@/components/drive/drive-views';

export const metadata: Metadata = { title: 'Drive' };

export default async function FolderPage({
  params,
}: {
  params: Promise<{ folderId: string }>;
}) {
  const { folderId } = await params;
  return <FolderView folderId={folderId} />;
}
