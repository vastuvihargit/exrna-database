'use client';

import Link from 'next/link';
import { LogOut, Settings, ShieldCheck, User } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { hasPermission, useLogout, useSession } from '@/hooks/use-session';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function UserMenu() {
  const { data: session } = useSession();
  const logout = useLogout();

  if (!session) {
    return (
      <Button variant="ghost" size="icon" aria-label="Account">
        <User className="size-4" />
      </Button>
    );
  }

  const canAdminister =
    session.user.isSuperAdmin ||
    hasPermission(session, 'user.manage') ||
    hasPermission(session, 'audit.view');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Account menu for ${session.user.name}`}>
          <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {initials(session.user.name)}
          </span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <p className="text-sm font-medium">{session.user.name}</p>
          <p className="truncate text-xs text-muted-foreground">{session.user.email}</p>
          {session.roles.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {session.roles.map((role) => role.name).join(', ')}
            </p>
          ) : null}
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href="/account">
            <Settings className="size-4" /> Account &amp; security
          </Link>
        </DropdownMenuItem>

        {canAdminister ? (
          <DropdownMenuItem asChild>
            <Link href="/admin">
              <ShieldCheck className="size-4" /> Administration
            </Link>
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={() => logout.mutate('this')} disabled={logout.isPending}>
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => logout.mutate('all')} disabled={logout.isPending}>
          <LogOut className="size-4" /> Sign out everywhere
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
