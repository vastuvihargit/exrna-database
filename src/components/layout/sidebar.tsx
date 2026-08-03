'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn, formatBytes } from '@/lib/utils';
import { NewMenu } from '@/components/drive/new-menu';
import { hasPermission, useSession } from '@/hooks/use-session';
import { navSections, type NavItem } from './nav-config';

interface SidebarProps {
  className?: string;
  onNavigate?: () => void;
}

function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-sidebar-accent text-accent-foreground' : 'text-sidebar-foreground hover:bg-sidebar-accent/60',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export function Sidebar({ className, onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const { data: session } = useSession();

  const storage = session?.storage;
  const usedPercent =
    storage && storage.quotaBytes > 0
      ? Math.min(100, Math.round((storage.usedBytes / storage.quotaBytes) * 100))
      : 0;

  const canAdminister =
    session?.user.isSuperAdmin ||
    hasPermission(session, 'user.manage') ||
    hasPermission(session, 'audit.view');

  return (
    <nav
      aria-label="Main navigation"
      className={cn('flex h-full w-64 flex-col border-r border-sidebar-border bg-sidebar', className)}
    >
      <div className="p-3">
        <NewMenu className="w-full justify-start gap-2" onAction={onNavigate} />
      </div>

      <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        {navSections.map((section) => {
          // Sections are hidden entirely from employees who cannot use them — the server
          // enforces this too; hiding it here just avoids a dead end.
          if (section.id === 'admin' && !canAdminister) return null;
          if (section.requiresPermission && !hasPermission(session, section.requiresPermission)) {
            return null;
          }

          return (
            <div key={section.id} className="space-y-1">
              {section.label ? (
                <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {section.label}
                </p>
              ) : null}
              {section.items.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          );
        })}
      </div>

      <div className="border-t border-sidebar-border p-4">
        <p className="mb-2 text-xs font-medium text-muted-foreground">Storage</p>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={usedPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Storage used"
        >
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${usedPercent}%` }} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {storage
            ? `${formatBytes(storage.usedBytes)} of ${formatBytes(storage.quotaBytes)} used`
            : 'Loading…'}
        </p>
      </div>
    </nav>
  );
}
