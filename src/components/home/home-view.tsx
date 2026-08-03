'use client';

import * as React from 'react';
import Link from 'next/link';
import { Building2, FlaskConical, FolderClosed, ShieldCheck } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { DriveItemCollection } from '@/components/drive/drive-item-collection';
import { FileDetailsPanel } from '@/components/drive/file-details-panel';
import { NewMenu } from '@/components/drive/new-menu';
import { useDrives, useRecent } from '@/hooks/use-drive';
import type { FileDto } from '@/hooks/use-files';
import { useReviews } from '@/hooks/use-reviews';
import { useSession } from '@/hooks/use-session';

/** Enough recent work to recognise, few enough to scan without scrolling. */
const RECENT_FOLDERS = 4;
const RECENT_FILES = 8;
const DRIVE_SHORTCUTS = 6;

/**
 * The first screen after signing in.
 *
 * It used to be a build tracker: "Phase 1 (foundation) is in place", four cards labelled
 * with phase numbers, and an architecture reference pointing at `docs/phase-0/`. That is
 * a status page for the people building this, shown to the people using it.
 *
 * A drive's home answers three questions instead — what is waiting on me, what was I
 * doing, and where do I keep things — in that order, because the first is the only one
 * with a deadline attached.
 */
export function HomeView() {
  const session = useSession();
  const recent = useRecent();
  const drives = useDrives();
  const reviews = useReviews('assigned');
  const [selected, setSelected] = React.useState<FileDto | null>(null);

  const firstName = session.data?.user.name?.trim().split(/\s+/)[0];
  const pending = (reviews.data ?? []).filter((review) => review.status === 'pending');

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {firstName ? `Welcome back, ${firstName}` : 'Welcome back'}
          </h1>
          <p className="mt-1 text-muted-foreground">
            Every research file in one place — versioned, searchable, and only visible to the
            people it was shared with.
          </p>
        </div>
        <NewMenu />
      </div>

      {pending.length > 0 ? (
        <Link
          href="/reviews"
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 transition-colors hover:bg-amber-500/15"
        >
          <ShieldCheck className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block font-medium">
              {pending.length} {pending.length === 1 ? 'file is' : 'files are'} waiting for your
              review
            </span>
            <span className="block truncate text-sm text-muted-foreground">
              {pending
                .slice(0, 3)
                .map((review) => review.fileName)
                .join(', ')}
              {pending.length > 3 ? ` and ${pending.length - 3} more` : ''}
            </span>
          </span>
        </Link>
      ) : null}

      <section aria-labelledby="home-recent">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="home-recent" className="text-sm font-semibold">
            Pick up where you left off
          </h2>
          <Link href="/recent" className="text-sm text-muted-foreground hover:underline">
            See all recent
          </Link>
        </div>

        <DriveItemCollection
          folders={recent.data?.folders?.slice(0, RECENT_FOLDERS)}
          files={recent.data?.files?.slice(0, RECENT_FILES)}
          isLoading={recent.isLoading}
          error={recent.error}
          emptyTitle="Nothing here yet"
          emptyDescription="Use the New button to upload your first files, or open a department or project drive below."
          onOpenFile={setSelected}
        />
      </section>

      <section aria-labelledby="home-drives">
        <h2 id="home-drives" className="mb-3 text-sm font-semibold">
          Where your files live
        </h2>

        {drives.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <DriveCard
              href="/my-drive"
              icon={FolderClosed}
              name="My Drive"
              detail="Yours alone until you share something"
            />
            {(drives.data?.departments ?? []).slice(0, DRIVE_SHORTCUTS).map((drive) => (
              <DriveCard
                key={drive.id}
                href={drive.href}
                icon={Building2}
                name={drive.name}
                detail="Department drive"
              />
            ))}
            {(drives.data?.projects ?? []).slice(0, DRIVE_SHORTCUTS).map((drive) => (
              <DriveCard
                key={drive.id}
                href={drive.href}
                icon={FlaskConical}
                name={drive.name}
                detail={drive.code ? `Project · ${drive.code}` : 'Project drive'}
              />
            ))}
          </ul>
        )}
      </section>

      <FileDetailsPanel file={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}

function DriveCard({
  href,
  icon: Icon,
  name,
  detail,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  name: string;
  detail: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex h-full items-start gap-3 rounded-md border p-4 transition-colors hover:border-primary/50 hover:bg-muted/50"
      >
        <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0">
          <span className="block truncate font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">{detail}</span>
        </span>
      </Link>
    </li>
  );
}
