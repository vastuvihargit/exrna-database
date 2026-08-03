import type { Metadata } from 'next';

import { ProjectOverview } from '@/components/research/project-overview';

export const metadata: Metadata = { title: 'Project overview' };

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectOverview projectId={projectId} />;
}
