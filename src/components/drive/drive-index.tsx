'use client';

import Link from 'next/link';
import { Building2, FlaskConical, LayoutDashboard } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useDrives } from '@/hooks/use-drive';
import { DriveError } from './drive-browser';

/**
 * Landing pages for department and project drives.
 *
 * Only drives the viewer may open are listed — the API decides that, not this
 * component. A drive with no root folder yet has simply never been opened; the link
 * still works and creates it.
 */
export function DepartmentDriveIndex() {
  const drives = useDrives();

  if (drives.error) return <DriveError error={drives.error} />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Department drives</h1>
        <p className="mt-1 text-muted-foreground">
          Shared space for each department. Access follows your department and your role.
        </p>
      </header>

      {drives.isLoading ? (
        <GridSkeleton />
      ) : drives.data && drives.data.departments.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {drives.data.departments.map((drive) => (
            <li key={drive.id}>
              <Link
                href={drive.href}
                className="flex h-full flex-col rounded-md border p-4 transition-colors hover:border-primary/50 hover:bg-muted/50"
              >
                <div className="flex items-center gap-2">
                  <Building2 className="size-5 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate font-medium">{drive.name}</span>
                </div>
                {drive.code ? (
                  <Badge variant="secondary" className="mt-3 w-fit">
                    {drive.code}
                  </Badge>
                ) : null}
                {!drive.rootFolderId ? (
                  <p className="mt-2 text-xs text-muted-foreground">Not opened yet</p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyDrives
          title="No department drives available to you"
          description="You are not a member of a department, and no department has been shared with your role."
        />
      )}
    </div>
  );
}

export function ProjectDriveIndex() {
  const drives = useDrives();

  if (drives.error) return <DriveError error={drives.error} />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Project drives</h1>
        <p className="mt-1 text-muted-foreground">
          Every project drive starts with the same twelve folders, so a protocol is always in the
          same place.
        </p>
      </header>

      {drives.isLoading ? (
        <GridSkeleton />
      ) : drives.data && drives.data.projects.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {drives.data.projects.map((drive) => (
            <li key={drive.id} className="rounded-md border transition-colors hover:border-primary/50">
              <Link
                href={drive.href}
                className="flex h-full flex-col rounded-t-md p-4 transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center gap-2">
                  <FlaskConical className="size-5 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate font-medium">{drive.name}</span>
                </div>
                {drive.code ? (
                  <Badge variant="secondary" className="mt-3 w-fit">
                    {drive.code}
                  </Badge>
                ) : null}
                {!drive.rootFolderId ? (
                  <p className="mt-2 text-xs text-muted-foreground">Not opened yet</p>
                ) : null}
              </Link>
              {/* The drive answers "where are the files"; the overview answers "what is
                  this project" — experiments, team, data mix and recent activity. */}
              <Link
                href={`/projects/${drive.id}/overview`}
                className="flex items-center gap-1.5 border-t px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <LayoutDashboard className="size-3.5" aria-hidden="true" />
                Project overview
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyDrives
          title="You are not on a project yet"
          description="Project drives appear here once you are added to a project team."
        />
      )}
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

function EmptyDrives({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-md border border-dashed p-12 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
