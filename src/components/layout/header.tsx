'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Dna, Menu, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { NotificationBell } from './notification-bell';
import { ShortcutsDialog } from './shortcuts-dialog';
import { Sidebar } from './sidebar';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

export function Header({ appName }: { appName: string }) {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  /**
   * `/` and `?` are the two shortcuts people try without being told, so they are the two
   * that live here rather than in the folder view — they have to work on every page.
   */
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === '/') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('input[type="search"][name="q"]')?.focus();
        return;
      }

      if (event.key === '?') {
        event.preventDefault();
        setShortcutsOpen(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background px-4">
      {/* Below lg the sidebar collapses into a sheet. */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation menu">
            <Menu className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar className="w-full border-r-0" onNavigate={() => setMobileNavOpen(false)} />
        </SheetContent>
      </Sheet>

      <Link href="/home" className="flex items-center gap-2 font-semibold">
        <Dna className="size-5 text-primary" aria-hidden="true" />
        <span className="hidden sm:inline">{appName}</span>
      </Link>

      {/* useSearchParams opts its subtree out of static rendering, so the boundary is
          required — without it every page that renders the shell would fail to build. */}
      <React.Suspense fallback={<div className="mx-auto w-full max-w-2xl" />}>
        <HeaderSearch />
      </React.Suspense>

      <div className="flex items-center gap-1">
        <NotificationBell />
        <ThemeToggle />
        <UserMenu />
      </div>

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </header>
  );
}

/**
 * The search box submits rather than searching as you type.
 *
 * Every keystroke would be a permission-filtered query across the whole archive, and a
 * researcher typing a sample ID does not want results for its prefixes. Enter (or the
 * form's implicit submit) navigates to /search, which owns the state from then on.
 */
function HeaderSearch() {
  const router = useRouter();
  const params = useSearchParams();
  const [term, setTerm] = React.useState('');

  // Keeps the box in step when the user lands on /search from a link or the back button.
  React.useEffect(() => {
    setTerm(params.get('q') ?? '');
  }, [params]);

  return (
    <form
      role="search"
      className="mx-auto flex w-full max-w-2xl items-center"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = term.trim();
        if (!trimmed) return;
        router.push(`/search?q=${encodeURIComponent(trimmed)}`);
      }}
    >
      <div className="relative w-full">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          name="q"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search files, folders, samples, experiments…"
          className="pl-9"
          aria-label="Search the drive"
        />
      </div>
    </form>
  );
}
