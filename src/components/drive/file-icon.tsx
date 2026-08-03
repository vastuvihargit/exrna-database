'use client';

import {
  Archive,
  Dna,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FlaskConical,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * One icon per file category, matching the categories the server assigns from the
 * extension (`server/domain/file-types.ts`). The category comes from the API rather than
 * being re-derived here, so the icon can never disagree with what was stored.
 */
const BY_CATEGORY: Record<string, { icon: LucideIcon; className: string }> = {
  document: { icon: FileText, className: 'text-blue-500' },
  spreadsheet: { icon: FileSpreadsheet, className: 'text-emerald-600' },
  presentation: { icon: FileText, className: 'text-orange-500' },
  image: { icon: FileImage, className: 'text-violet-500' },
  raw_data: { icon: FileJson, className: 'text-amber-600' },
  sequence: { icon: Dna, className: 'text-teal-500' },
  chromatography: { icon: FlaskConical, className: 'text-cyan-600' },
  archive: { icon: Archive, className: 'text-muted-foreground' },
  code: { icon: FileCode, className: 'text-slate-500' },
  video: { icon: FileVideo, className: 'text-rose-500' },
  audio: { icon: FileAudio, className: 'text-pink-500' },
  other: { icon: FileText, className: 'text-muted-foreground' },
};

export function FileIcon({ category, className }: { category: string; className?: string }) {
  const entry = BY_CATEGORY[category] ?? BY_CATEGORY.other!;
  const Icon = entry.icon;
  return <Icon className={cn('shrink-0', entry.className, className)} aria-hidden="true" />;
}
