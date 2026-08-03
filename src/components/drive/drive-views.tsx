'use client';

import {
  useDepartmentDrive,
  useFolder,
  useMyDrive,
  useProjectDrive,
} from '@/hooks/use-drive';
import { DriveBrowser } from './drive-browser';

/**
 * Four entry points, one browser.
 *
 * Each drive resolves its root through a different endpoint — that is where the
 * membership check lives — but once a folder id is known every drive behaves the same,
 * so navigation below the root always lands on /drive/[folderId].
 */
export function FolderView({ folderId }: { folderId: string }) {
  const query = useFolder(folderId);
  return (
    <DriveBrowser
      folder={query.data?.folder}
      breadcrumbs={query.data?.breadcrumbs ?? []}
      isLoading={query.isLoading}
      error={query.error}
    />
  );
}

export function MyDriveView() {
  const query = useMyDrive();
  return (
    <DriveBrowser
      folder={query.data?.folder}
      breadcrumbs={query.data?.breadcrumbs ?? []}
      isLoading={query.isLoading}
      error={query.error}
    />
  );
}

export function DepartmentDriveView({ departmentId }: { departmentId: string }) {
  const query = useDepartmentDrive(departmentId);
  return (
    <DriveBrowser
      folder={query.data?.folder}
      breadcrumbs={query.data?.breadcrumbs ?? []}
      isLoading={query.isLoading}
      error={query.error}
    />
  );
}

export function ProjectDriveView({ projectId }: { projectId: string }) {
  const query = useProjectDrive(projectId);
  return (
    <DriveBrowser
      folder={query.data?.folder}
      breadcrumbs={query.data?.breadcrumbs ?? []}
      isLoading={query.isLoading}
      error={query.error}
    />
  );
}
