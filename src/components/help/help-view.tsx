'use client';

import * as React from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  Building2,
  CheckCircle2,
  Clock,
  FlaskConical,
  FolderClosed,
  History,
  Keyboard,
  Package,
  Search,
  Share2,
  ShieldCheck,
  Star,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ShortcutsDialog } from '@/components/layout/shortcuts-dialog';
import { hasPermission, useSession } from '@/hooks/use-session';

/**
 * What each part of the drive is for.
 *
 * The sidebar is twelve destinations across six groups, and several of the pairs only
 * differ by a convention somebody has to be told once — Archive against Trash, a
 * department drive against a project drive. Nothing in the interface teaches that, so a
 * new employee learns it by guessing, or by asking the person next to them.
 *
 * This page is the answer they would have been given. Entries carry the icon of the page
 * they describe so the connection is made by recognition rather than by reading, and each
 * one says when to reach for the thing rather than what it technically is.
 */

interface Entry {
  icon: LucideIcon;
  term: string;
  href?: string;
  body: string;
}

interface Group {
  id: string;
  title: string;
  lede: string;
  entries: Entry[];
  requiresPermission?: string;
}

const GROUPS: Group[] = [
  {
    id: 'drives',
    title: 'Where files live',
    lede: 'Three places, chosen by who the work belongs to — not by what kind of file it is.',
    entries: [
      {
        icon: FolderClosed,
        term: 'My Drive',
        href: '/my-drive',
        body: 'Yours alone. Nobody else can see anything here until you share it. Use it for work in progress that is not ready to be found by someone searching.',
      },
      {
        icon: Building2,
        term: 'Department drives',
        href: '/departments',
        body: 'One per department, visible to everyone in it. This is where work lives when it belongs to the team rather than to a particular study — protocols, equipment records, standing references.',
      },
      {
        icon: FlaskConical,
        term: 'Project drives',
        href: '/projects',
        body: 'One per study, visible to the people assigned to it. Everything produced by a single piece of research belongs here, so that when the study ends its whole record is in one place.',
      },
    ],
  },
  {
    id: 'find',
    title: 'Finding things again',
    lede: 'Search is the fastest route once there is more than a screenful of anything.',
    entries: [
      {
        icon: Search,
        term: 'Search',
        href: '/search',
        body: 'Type in the box at the top and press Enter — it does not search as you type, because a half-typed sample ID would match the wrong things. On the results page you can narrow by file type, confidentiality, review state or experiment, and save a set of filters you use often.',
      },
      {
        icon: Share2,
        term: 'Shared with me',
        href: '/shared',
        body: 'Files and folders someone else gave you access to individually. Work you can reach because of your department or project does not appear here — only things shared with you by name.',
      },
      {
        icon: Clock,
        term: 'Recent',
        href: '/recent',
        body: 'What you have opened or changed lately, newest first. Usually quicker than remembering which folder something was in.',
      },
      {
        icon: Star,
        term: 'Starred',
        href: '/starred',
        body: 'Your own bookmarks. Starring is private — it changes nothing for anyone else and does not move the file.',
      },
    ],
  },
  {
    id: 'review',
    title: 'Getting work signed off',
    lede: 'A file can be submitted for review, and an approved version is the one others should trust.',
    entries: [
      {
        icon: ShieldCheck,
        term: 'Pending reviews',
        href: '/reviews',
        body: 'Files waiting on you. Anything here is somebody else blocked on your answer, which is why the count also appears on your home page.',
      },
      {
        icon: CheckCircle2,
        term: 'Approved files',
        href: '/approved',
        body: 'Everything that has cleared review. If you need the version of a result that can be cited or handed on, take it from here rather than from the folder.',
      },
    ],
  },
  {
    id: 'lifecycle',
    title: 'When work is finished',
    lede: 'Two different endings, and the difference matters — see the note below.',
    entries: [
      {
        icon: Archive,
        term: 'Archive',
        href: '/archive',
        body: 'For studies that are over but whose data must stay available. Archived work is out of your way, still searchable, and kept indefinitely.',
      },
      {
        icon: Trash2,
        term: 'Trash',
        href: '/trash',
        body: 'For things that should not have existed — a duplicate upload, a mistake. Items can be restored from here, but the intention is that they go away.',
      },
    ],
  },
  {
    id: 'inventory',
    title: 'The laboratory store',
    lede: 'Physical materials, tracked the same way as files.',
    requiresPermission: 'inventory.view',
    entries: [
      {
        icon: Package,
        term: 'Inventory',
        href: '/inventory',
        body: 'An item defines what a material is and when to reorder it; it starts empty. Stock only moves through a receipt, an issue or a correction, each of which records who did it and when — so the number on the screen always has a history behind it.',
      },
    ],
  },
];

/** Concepts that are not pages — they turn up inside a file, wherever it is kept. */
const CONCEPTS: Entry[] = [
  {
    icon: History,
    term: 'Versions',
    body: 'Uploading a file over an existing one adds a version instead of replacing it. Every earlier version stays downloadable, so nothing is ever lost. The "what changed?" note is optional and worth the ten seconds — it is what saves the next person opening three versions to work out which is which.',
  },
  {
    icon: Share2,
    term: 'Sharing',
    body: 'Access is granted per person, at one of six levels: Viewer (open and download), Commenter, Editor (upload versions, edit details), Reviewer, Approver, then Manager, who can also share and delete. Each level includes everything below it.',
  },
];

export function HelpView() {
  const { data: session } = useSession();
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  const groups = GROUPS.filter(
    (group) => !group.requiresPermission || hasPermission(session, group.requiresPermission),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">How this drive is organised</h1>
        <p className="mt-2 text-muted-foreground">
          Every part of the sidebar, and when to reach for it. Nothing here is a rule enforced
          by the software — they are the conventions that keep everyone&rsquo;s work findable.
        </p>
      </header>

      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`help-${group.id}`} className="space-y-4">
          <div>
            <h2 id={`help-${group.id}`} className="text-lg font-semibold">
              {group.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{group.lede}</p>
          </div>

          <dl className="space-y-3">
            {group.entries.map((entry) => (
              <EntryRow key={entry.term} entry={entry} />
            ))}
          </dl>

          {group.id === 'lifecycle' ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
              <span className="font-medium">Archive when the work is done; trash when it was
              never wanted.</span>{' '}
              A finished study belongs in the archive — putting it in the trash suggests it was
              a mistake, and anyone looking for it later will assume it was deleted on purpose.
            </p>
          ) : null}
        </section>
      ))}

      <section aria-labelledby="help-concepts" className="space-y-4">
        <div>
          <h2 id="help-concepts" className="text-lg font-semibold">
            Two things worth knowing about any file
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            These apply wherever the file is kept.
          </p>
        </div>

        <dl className="space-y-3">
          {CONCEPTS.map((entry) => (
            <EntryRow key={entry.term} entry={entry} />
          ))}
        </dl>
      </section>

      <section aria-labelledby="help-faster" className="space-y-3">
        <h2 id="help-faster" className="text-lg font-semibold">
          Doing it faster
        </h2>
        <p className="text-sm text-muted-foreground">
          Everything in this application has a button — the shortcuts are only quicker. Press{' '}
          <kbd className="rounded border bg-muted px-1.5 py-px font-mono text-xs">?</kbd> anywhere
          to see the list, or open it here.
        </p>
        <Button variant="outline" onClick={() => setShortcutsOpen(true)}>
          <Keyboard className="size-4" /> Show shortcuts
        </Button>
      </section>

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}

function EntryRow({ entry }: { entry: Entry }) {
  const Icon = entry.icon;

  return (
    <div className="flex gap-3 rounded-lg border p-4">
      <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <dt className="font-medium">
          {entry.href ? (
            <Link href={entry.href} className="hover:underline">
              {entry.term}
            </Link>
          ) : (
            entry.term
          )}
        </dt>
        <dd className="mt-1 text-sm text-muted-foreground">{entry.body}</dd>
      </div>
    </div>
  );
}
