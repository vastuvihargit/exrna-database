'use client';

import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  UploadCloud,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn, formatBytes } from '@/lib/utils';
import type { Uploader, UploadItem } from '@/hooks/use-upload';

/**
 * Fixed transfer panel, the way a drive shows uploads.
 *
 * Deliberately outside the folder view: navigating away mid-upload must not cancel it,
 * and the tray is the only thing telling the user bytes are still moving.
 */
export function UploadTray({ uploader }: { uploader: Uploader }) {
  const [collapsed, setCollapsed] = useState(false);
  const { items } = uploader;

  if (items.length === 0) return null;

  const done = items.filter((item) => item.status === 'done').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const active = uploader.activeCount;

  const heading =
    active > 0
      ? `Uploading ${active} file${active === 1 ? '' : 's'}`
      : failed > 0
        ? `${failed} upload${failed === 1 ? '' : 's'} failed`
        : `${done} upload${done === 1 ? '' : 's'} complete`;

  return (
    <section
      aria-label="Uploads"
      className="fixed bottom-4 right-4 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border bg-background shadow-lg"
    >
      <header className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2">
        <UploadCloud className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" aria-live="polite">
          {heading}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronUp className="size-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-4" aria-hidden="true" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={uploader.clearFinished}
          disabled={active === items.length}
          aria-label="Clear finished uploads"
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </header>

      {!collapsed ? (
        <ul className="max-h-72 divide-y overflow-y-auto">
          {items.map((item) => (
            <li key={item.id} className="px-3 py-2.5">
              <Row item={item} onCancel={uploader.cancel} onRetry={uploader.retry} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Row({
  item,
  onCancel,
  onRetry,
}: {
  item: UploadItem;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const isActive = ['queued', 'authorizing', 'uploading', 'finalizing'].includes(item.status);

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm" title={item.name}>
          {item.name}
        </span>

        {item.status === 'done' ? (
          <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-label="Uploaded" />
        ) : item.status === 'failed' ? (
          <AlertCircle className="size-4 shrink-0 text-destructive" aria-label="Failed" />
        ) : null}

        {item.status === 'failed' ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onRetry(item.id)}
            aria-label={`Retry ${item.name}`}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}

        {isActive ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onCancel(item.id)}
            aria-label={`Cancel ${item.name}`}
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {isActive ? (
        <div
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={item.progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${item.name} upload progress`}
        >
          <div
            className={cn(
              'h-full rounded-full bg-primary transition-[width] duration-200',
              item.status === 'finalizing' && 'animate-pulse',
            )}
            style={{ width: `${item.progress}%` }}
          />
        </div>
      ) : null}

      <p
        className={cn(
          'mt-1 text-xs',
          item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {describe(item)}
      </p>
    </div>
  );
}

function describe(item: UploadItem): string {
  switch (item.status) {
    case 'queued':
      return `Waiting — ${formatBytes(item.size)}`;
    case 'authorizing':
      return 'Checking permission and space…';
    case 'uploading':
      return `${item.progress}% of ${formatBytes(item.size)}`;
    case 'finalizing':
      return 'Verifying checksum and storing…';
    case 'done':
      return `Uploaded — ${formatBytes(item.size)}`;
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return item.error ?? 'Upload failed';
    default:
      return '';
  }
}
