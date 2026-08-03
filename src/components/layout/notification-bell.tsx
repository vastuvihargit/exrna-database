'use client';

import Link from 'next/link';
import { Bell } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatRelativeTime } from '@/lib/utils';
import { useMarkNotificationRead, useNotifications } from '@/hooks/use-sharing';

/**
 * A notification carries a label, never content.
 *
 * "Alice commented on Tox-Study-Protocol.pdf" is enough to decide whether to click; the
 * comment body stays behind the permission check on the file. That matters because a
 * notification is delivered without a permission check at read time — the check happened
 * when it was sent.
 */
export function NotificationBell() {
  const notifications = useNotifications();
  const markRead = useMarkNotificationRead();

  const unread = notifications.data?.unread ?? 0;
  const items = notifications.data?.items ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          <Bell className="size-5" aria-hidden="true" />
          {unread > 0 ? (
            <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          Notifications
          {unread > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs font-normal"
              onClick={(event) => {
                event.preventDefault();
                markRead.mutate(undefined);
              }}
            >
              Mark all read
            </Button>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {items.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            Nothing new. Shares, mentions and review requests land here.
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {items.map((entry) => (
              <DropdownMenuItem key={entry.id} asChild>
                <Link
                  href={entry.entityType === 'folder' ? `/drive/${entry.entityId}` : '/recent'}
                  className="flex flex-col items-start gap-0.5"
                  onClick={() => {
                    if (!entry.readAt) markRead.mutate(entry.id);
                  }}
                >
                  <span className="flex w-full items-start gap-2">
                    {!entry.readAt ? (
                      <span
                        className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                        aria-label="Unread"
                      />
                    ) : (
                      <span className="mt-1.5 size-1.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 whitespace-normal text-sm">{entry.message}</span>
                  </span>
                  <span className="pl-3.5 text-xs text-muted-foreground">
                    {formatRelativeTime(entry.createdAt)}
                  </span>
                </Link>
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
