import type { Metadata } from 'next';

import { DepartmentDriveIndex } from '@/components/drive/drive-index';

export const metadata: Metadata = { title: 'Department drives' };

export default function DepartmentsPage() {
  return <DepartmentDriveIndex />;
}
