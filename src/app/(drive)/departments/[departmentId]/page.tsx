import type { Metadata } from 'next';

import { DepartmentDriveView } from '@/components/drive/drive-views';

export const metadata: Metadata = { title: 'Department drive' };

export default async function DepartmentDrivePage({
  params,
}: {
  params: Promise<{ departmentId: string }>;
}) {
  const { departmentId } = await params;
  return <DepartmentDriveView departmentId={departmentId} />;
}
