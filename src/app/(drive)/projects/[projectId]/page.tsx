import type { Metadata } from 'next';

import { ProjectDriveView } from '@/components/drive/drive-views';

export const metadata: Metadata = { title: 'Project drive' };

export default async function ProjectDrivePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectDriveView projectId={projectId} />;
}
