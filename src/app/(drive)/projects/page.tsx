import type { Metadata } from 'next';

import { ProjectDriveIndex } from '@/components/drive/drive-index';

export const metadata: Metadata = { title: 'Project drives' };

export default function ProjectsPage() {
  return <ProjectDriveIndex />;
}
