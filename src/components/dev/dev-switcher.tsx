'use client';

/**
 * 🛠 DEV — the development-only user switcher.
 *
 * Rendered by `dev-switcher-mount.tsx`, which is a server component that returns null
 * outside development. This file assumes it is only ever mounted in a development build
 * and does not attempt to check for itself: a client-side environment check would be a
 * suggestion, and the server-side one is a decision.
 *
 * Switching goes through `/api/dev/switch-user`, which issues a **real session**. The
 * page is then hard-reloaded rather than having React state patched, because every
 * server component on the page was rendered for the previous actor — a soft refresh
 * would leave a half-switched UI that is worse than no switcher at all.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronUp, LayoutDashboard, LogOut, ShieldAlert, Wrench, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiRequest, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useSession, hasPermission } from '@/hooks/use-session';

interface DevUser {
  id: string;
  name: string;
  email: string;
  departmentName: string | null;
  isSuperAdmin: boolean;
  primaryRole: { key: string; name: string; rank: number } | null;
  allRoles: Array<{ key: string; name: string; scopeType: string }>;
}

export function DevSwitcher() {
  const [open, setOpen] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();

  const session = useSession();

  // Only fetched once the panel is opened: an unused developer tool should cost nothing
  // on every page load.
  const users = useQuery({
    queryKey: ['dev', 'users'],
    queryFn: () => apiRequest<{ users: DevUser[] }>('/api/dev/users'),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });

  const switchUser = useMutation({
    mutationFn: (userId: string) =>
      apiRequest('/api/dev/switch-user', { method: 'POST', body: { userId } }),
    onMutate: (userId: string) => setSwitchingId(userId),
    onSuccess: () => {
      // Full reload, not router.refresh(): server components above this one were
      // rendered for the previous actor, and the layout guard itself must re-run.
      queryClient.clear();
      window.location.reload();
    },
    onError: () => setSwitchingId(null),
  });

  const signOut = useMutation({
    mutationFn: () => apiRequest('/api/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      queryClient.clear();
      window.location.href = '/login';
    },
  });

  const close = useCallback(() => setOpen(false), []);

  // Escape closes, and focus returns to the trigger — otherwise keyboard users are left
  // at the top of the document with no idea where they are.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        buttonRef.current?.focus();
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      close();
    };

    document.addEventListener('keydown', onKeyDown);
    // `pointerdown` rather than `click`: closing on click would fire after a button
    // inside the panel had already been removed from the DOM by a re-render.
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  const currentUser = session.data?.user;
  const currentRole =
    session.data?.roles.find((role) => role.scopeType === 'company') ?? session.data?.roles[0];
  const canSeeAdmin =
    hasPermission(session.data, 'user.manage') || hasPermission(session.data, 'audit.view');

  const isBusy = switchUser.isPending || signOut.isPending;

  return (
    <div
      className={cn(
        // Bottom-right, above the Sonner toaster's stacking context, and inset far
        // enough on small screens to clear iOS home-indicator territory.
        'fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-[90]',
        'flex flex-col items-end gap-2 print:hidden',
      )}
      data-dev-switcher=""
    >
      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Development user switcher"
          aria-modal="false"
          className={cn(
            'w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-amber-500/40',
            'bg-background shadow-2xl',
            // The panel can be taller than a phone; cap it and scroll the list, never
            // the page behind it.
            'max-h-[min(32rem,calc(100vh-6rem))] flex flex-col',
          )}
        >
          <header className="flex items-start justify-between gap-2 border-b bg-amber-500/10 px-3 py-2">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <Wrench className="size-3.5 shrink-0" aria-hidden="true" />
                Development switcher
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Issues a real session. Never available in production.
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close the development switcher"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </header>

          {/* ── who you are now ─────────────────────────────────────────── */}
          <div className="border-b px-3 py-2.5">
            <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
              Signed in as
            </p>
            {session.isLoading ? (
              <div className="mt-1.5 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
            ) : currentUser ? (
              <div className="mt-1">
                <p className="truncate text-sm font-medium">{currentUser.name}</p>
                <p className="truncate text-xs text-muted-foreground">{currentUser.email}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {currentUser.isSuperAdmin ? (
                    <Badge variant="destructive" className="text-[0.65rem]">
                      Super Admin
                    </Badge>
                  ) : null}
                  {currentRole ? (
                    <Badge variant="secondary" className="text-[0.65rem]">
                      {currentRole.name}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[0.65rem]">
                      No role granted
                    </Badge>
                  )}
                </div>
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                Signed out — pick an account below to sign in.
              </p>
            )}
          </div>

          {/* ── who you could be ────────────────────────────────────────── */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <p className="px-3 pb-1 pt-2.5 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
              Switch to
            </p>

            {users.isLoading ? (
              <ul className="space-y-1 px-2 pb-2">
                {[0, 1, 2, 3].map((row) => (
                  <li key={row} className="rounded-md px-2 py-2">
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="mt-1.5 h-3 w-28" />
                  </li>
                ))}
              </ul>
            ) : users.isError ? (
              <div className="px-3 pb-3">
                <p className="flex items-start gap-1.5 text-sm text-destructive">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>
                    {users.error instanceof ApiError && users.error.status === 404
                      ? 'Developer tooling is disabled in this build.'
                      : `Could not load accounts${
                          users.error instanceof ApiError ? `: ${users.error.message}` : ''
                        }`}
                  </span>
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 w-full"
                  onClick={() => void users.refetch()}
                >
                  Try again
                </Button>
              </div>
            ) : (users.data?.users.length ?? 0) === 0 ? (
              <p className="px-3 pb-3 text-sm text-muted-foreground">
                No active accounts found. Run <code className="font-mono">npm run seed</code> to
                create some.
              </p>
            ) : (
              <ul className="space-y-0.5 px-2 pb-2">
                {users.data?.users.map((user) => {
                  const isCurrent = user.id === currentUser?.id;
                  return (
                    <li key={user.id}>
                      <button
                        type="button"
                        disabled={isBusy || isCurrent}
                        onClick={() => switchUser.mutate(user.id)}
                        aria-current={isCurrent ? 'true' : undefined}
                        className={cn(
                          'flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left',
                          'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          isCurrent && 'bg-muted/60',
                          isBusy && 'opacity-60',
                          'disabled:cursor-not-allowed',
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{user.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {user.primaryRole?.name ?? 'No role'}
                            {user.departmentName ? ` · ${user.departmentName}` : ''}
                          </span>
                          {/* Two seeded admins can carry the same role and department, and
                              then the rows above are identical. The email is what tells
                              them apart. */}
                          <span className="block truncate text-[0.7rem] text-muted-foreground/70">
                            {user.email}
                          </span>
                        </span>
                        <span className="shrink-0 text-[0.65rem] text-muted-foreground">
                          {switchingId === user.id
                            ? 'Switching…'
                            : isCurrent
                              ? 'Current'
                              : user.isSuperAdmin
                                ? 'SA'
                                : ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {switchUser.isError ? (
            <p className="border-t px-3 py-2 text-xs text-destructive">
              {switchUser.error instanceof ApiError
                ? switchUser.error.message
                : 'The switch failed.'}
            </p>
          ) : null}

          {/* ── actions ─────────────────────────────────────────────────── */}
          <footer className="flex items-center gap-2 border-t px-2 py-2">
            {canSeeAdmin ? (
              <Button variant="outline" size="sm" className="flex-1" asChild>
                <a href="/admin/system">
                  <LayoutDashboard className="mr-1.5 size-3.5" aria-hidden="true" />
                  Dev hub
                </a>
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={isBusy || !currentUser}
              onClick={() => signOut.mutate()}
            >
              <LogOut className="mr-1.5 size-3.5" aria-hidden="true" />
              {signOut.isPending ? 'Signing out…' : 'Sign out'}
            </Button>
          </footer>
        </div>
      ) : null}

      <Button
        ref={buttonRef}
        type="button"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Development user switcher"
        className={cn(
          'gap-1.5 border border-amber-500/50 bg-amber-500/90 text-amber-950 shadow-lg',
          'hover:bg-amber-500 focus-visible:ring-amber-600',
        )}
      >
        <Wrench className="size-3.5" aria-hidden="true" />
        <span className="font-semibold">DEV</span>
        {currentUser ? (
          <span className="hidden max-w-28 truncate text-xs font-normal opacity-80 sm:inline">
            {currentRole?.name ?? currentUser.name}
          </span>
        ) : null}
        <ChevronUp
          className={cn('size-3.5 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </Button>
    </div>
  );
}
