import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge conditional class names, resolving conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Human-readable byte size, e.g. 2.1 MB. Binary units, one decimal above KB. */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${i === 0 ? value : value.toFixed(decimals)} ${units[i]}`;
}

/** Relative time for activity feeds ("3 minutes ago"). */
export function formatRelativeTime(date: Date | string): string {
  const value = typeof date === 'string' ? new Date(date) : date;
  const seconds = Math.round((Date.now() - value.getTime()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  const divisions: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.34524, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];

  let duration = seconds;
  for (const [amount, unit] of divisions) {
    if (Math.abs(duration) < amount) return formatter.format(-Math.round(duration), unit);
    duration /= amount;
  }
  return formatter.format(-Math.round(duration), 'year');
}
