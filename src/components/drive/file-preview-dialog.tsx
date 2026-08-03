'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, ExternalLink, FileWarning, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils';
import { useFileVersions, type FileDto } from '@/hooks/use-files';
import { FileIcon } from './file-icon';

/**
 * Inline preview.
 *
 * Every byte shown here arrives through `/api/files/{id}/preview`, which checks the
 * permission, refuses any extension not on the previewable allow-list, and answers with a
 * sandboxing CSP. This component therefore never needs to reason about whether a file is
 * *safe* to render — the server has already decided that, and a file it declines simply
 * shows the download fallback below.
 *
 * Text-shaped formats are fetched rather than framed, for two reasons: a sandboxed
 * document cannot inherit the page's styling, and a 2 GB CSV must not be handed to the
 * browser in one piece. A ranged request caps what is read at `TEXT_PREVIEW_BYTES`.
 */

/** Enough to see the shape of a data file; small enough that no request is expensive. */
const TEXT_PREVIEW_BYTES = 512 * 1024;

/** Rows rendered from a delimited file before the tail is elided. */
const TABLE_PREVIEW_ROWS = 200;

type PreviewShape = 'pdf' | 'image' | 'video' | 'audio' | 'table' | 'text' | 'unsupported';

const TABLE_EXTENSIONS = new Set(['csv', 'tsv']);
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'json',
  'xml',
  'yaml',
  'yml',
  'fasta',
  'fa',
  'bed',
]);

function shapeFor(file: FileDto): PreviewShape {
  const extension = file.extension.toLowerCase();
  if (!file.previewable || !file.capabilities.canPreview) return 'unsupported';
  if (extension === 'pdf') return 'pdf';
  if (TABLE_EXTENSIONS.has(extension)) return 'table';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (file.category === 'image') return 'image';
  if (file.category === 'video') return 'video';
  if (file.category === 'audio') return 'audio';
  return 'unsupported';
}

export function FilePreviewDialog({
  file,
  onOpenChange,
}: {
  file: FileDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [versionId, setVersionId] = useState<string | null>(null);
  const versions = useFileVersions(file?.id ?? null);

  // A newly opened file starts on its current version; the picker is an override, so it
  // must not survive into the next file the user opens.
  useEffect(() => {
    setVersionId(null);
  }, [file?.id]);

  const shape = file ? shapeFor(file) : 'unsupported';
  const selectedVersion = versionId
    ? versions.data?.find((version) => version.id === versionId)
    : versions.data?.find((version) => version.isCurrent);

  const previewUrl = file
    ? `/api/files/${file.id}/preview${versionId ? `?versionId=${versionId}` : ''}`
    : null;
  const downloadUrl = file
    ? `/api/files/${file.id}/download${versionId ? `?versionId=${versionId}` : ''}`
    : null;

  return (
    <Dialog open={file !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] w-[min(96vw,1100px)] max-w-none flex-col gap-4 p-4 sm:p-6">
        {file && previewUrl && downloadUrl ? (
          <>
            <DialogHeader className="pr-10">
              <DialogTitle className="flex min-w-0 items-center gap-2">
                <FileIcon category={file.category} className="size-4" />
                <span className="truncate">{file.displayName}</span>
                {file.approvalStatus === 'approved' ? (
                  <Badge className="shrink-0 bg-emerald-600 hover:bg-emerald-600">Approved</Badge>
                ) : null}
              </DialogTitle>
              <DialogDescription>
                {formatBytes(selectedVersion?.fileSize ?? file.sizeBytes)} · .{file.extension}
                {selectedVersion
                  ? ` · version ${selectedVersion.versionNumber}, uploaded ${formatRelativeTime(
                      selectedVersion.uploadedAt,
                    )}`
                  : null}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap items-center gap-2">
              {versions.data && versions.data.length > 1 ? (
                <Select
                  value={selectedVersion?.id ?? ''}
                  onValueChange={(value) => setVersionId(value)}
                >
                  <SelectTrigger className="w-56" aria-label="Version to preview">
                    <SelectValue placeholder="Current version" />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.data.map((version) => (
                      <SelectItem key={version.id} value={version.id}>
                        Version {version.versionNumber}
                        {version.isCurrent ? ' (current)' : ''}
                        {version.isApproved ? ' · approved' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}

              <div className="ml-auto flex items-center gap-2">
                {shape !== 'unsupported' ? (
                  <Button variant="outline" size="sm" asChild>
                    {/* `noreferrer` matters: the preview response is sandboxed and must
                        not hand this page's URL to a document we did not author. */}
                    <a href={previewUrl} target="_blank" rel="noreferrer">
                      <ExternalLink className="mr-2 size-4" aria-hidden="true" /> Open in new tab
                    </a>
                  </Button>
                ) : null}
                {file.capabilities.canDownload ? (
                  <Button size="sm" asChild>
                    <a href={downloadUrl} download>
                      <Download className="mr-2 size-4" aria-hidden="true" /> Download
                    </a>
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden rounded-md border bg-muted/30">
              <PreviewSurface
                shape={shape}
                file={file}
                url={previewUrl}
                canDownload={file.capabilities.canDownload}
                downloadUrl={downloadUrl}
              />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PreviewSurface({
  shape,
  file,
  url,
  canDownload,
  downloadUrl,
}: {
  shape: PreviewShape;
  file: FileDto;
  url: string;
  canDownload: boolean;
  downloadUrl: string;
}) {
  switch (shape) {
    case 'pdf':
      // `<object>` renders its children when the browser will not display the resource,
      // which is the standards-provided fallback for a sandboxed PDF a viewer declines.
      return (
        <object data={url} type="application/pdf" className="size-full" title={file.displayName}>
          <Fallback
            title="This browser will not display the PDF inline"
            body="Download the file to read it, or open it in a new tab."
            canDownload={canDownload}
            downloadUrl={downloadUrl}
          />
        </object>
      );

    case 'image':
      return (
        <div className="flex size-full items-center justify-center overflow-auto p-4">
          {/* Deliberately not next/image: the bytes come from an authenticated,
              no-store API route, so there is nothing for the optimizer to cache. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={file.displayName}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );

    case 'video':
      return (
        <div className="flex size-full items-center justify-center bg-black">
          {/* Ranged requests are honoured by the preview route, which is what makes
              seeking work without downloading the whole file. */}
          <video src={url} controls preload="metadata" className="max-h-full max-w-full">
            <track kind="captions" />
          </video>
        </div>
      );

    case 'audio':
      return (
        <div className="flex size-full items-center justify-center p-6">
          <audio src={url} controls preload="metadata" className="w-full max-w-xl" />
        </div>
      );

    case 'table':
      return <DelimitedPreview url={url} extension={file.extension} />;

    case 'text':
      return <TextPreview url={url} extension={file.extension} />;

    default:
      return (
        <Fallback
          title={`.${file.extension} files cannot be previewed in the browser`}
          body={
            file.capabilities.canPreview
              ? 'This format has no safe inline renderer. Download it to open in the tool it belongs to.'
              : 'You do not have permission to preview this file.'
          }
          canDownload={canDownload}
          downloadUrl={downloadUrl}
        />
      );
  }
}

/**
 * Reads the head of a file as text.
 *
 * The `Range` header is what keeps this affordable: a truncated preview of a huge data
 * file is useful, downloading it into the tab to show 40 lines is not.
 */
function useTextHead(url: string): {
  text: string | null;
  truncated: boolean;
  error: string | null;
  isLoading: boolean;
} {
  const [state, setState] = useState<{
    text: string | null;
    truncated: boolean;
    error: string | null;
    isLoading: boolean;
  }>({ text: null, truncated: false, error: null, isLoading: true });

  useEffect(() => {
    const controller = new AbortController();
    setState({ text: null, truncated: false, error: null, isLoading: true });

    void (async () => {
      try {
        const response = await fetch(url, {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` },
          signal: controller.signal,
        });

        if (!response.ok && response.status !== 206) {
          // The route answers the standard envelope on failure, so the server's own
          // message (permission, unsupported type) is what the user sees.
          const payload = (await response.json().catch(() => null)) as
            | { error?: { message?: string } }
            | null;
          throw new Error(payload?.error?.message ?? `Preview failed (${response.status})`);
        }

        const text = await response.text();
        setState({
          text,
          truncated: response.status === 206 && text.length >= TEXT_PREVIEW_BYTES - 1,
          error: null,
          isLoading: false,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          text: null,
          truncated: false,
          error: error instanceof Error ? error.message : 'Preview failed',
          isLoading: false,
        });
      }
    })();

    return () => controller.abort();
  }, [url]);

  return state;
}

function TextPreview({ url, extension }: { url: string; extension: string }) {
  const { text, truncated, error, isLoading } = useTextHead(url);

  const formatted = useMemo(() => {
    if (text === null) return null;
    if (extension.toLowerCase() !== 'json') return text;
    // Pretty-printing is best-effort: a truncated JSON body will not parse, and showing
    // the raw head is more useful than an error.
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }, [text, extension]);

  if (isLoading) return <Loading />;
  if (error) return <PreviewError message={error} />;

  return (
    <div className="size-full overflow-auto">
      <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed">
        {formatted}
      </pre>
      {truncated ? <TruncationNote /> : null}
    </div>
  );
}

function DelimitedPreview({ url, extension }: { url: string; extension: string }) {
  const { text, truncated, error, isLoading } = useTextHead(url);

  const rows = useMemo(() => {
    if (!text) return [];
    const delimiter = extension.toLowerCase() === 'tsv' ? '\t' : ',';
    const lines = text.split(/\r?\n/);
    // A truncated read almost certainly cut the final line in half; dropping it avoids
    // rendering a row that does not exist in the file.
    const usable = truncated ? lines.slice(0, -1) : lines;
    return usable
      .filter((line) => line.length > 0)
      .slice(0, TABLE_PREVIEW_ROWS)
      .map((line) => splitDelimited(line, delimiter));
  }, [text, extension, truncated]);

  if (isLoading) return <Loading />;
  if (error) return <PreviewError message={error} />;
  if (rows.length === 0) {
    return <PreviewError message="This file has no readable rows." />;
  }

  const [header, ...body] = rows as [string[], ...string[][]];

  return (
    <div className="size-full overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-background">
          <tr>
            <th className="border-b border-r px-2 py-1.5 text-right font-normal text-muted-foreground">
              #
            </th>
            {header.map((cell, index) => (
              <th
                key={index}
                className="border-b px-2 py-1.5 text-left font-medium"
                title={cell}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="even:bg-muted/40">
              <td className="border-r px-2 py-1 text-right text-muted-foreground">
                {rowIndex + 1}
              </td>
              {header.map((_, cellIndex) => (
                <td key={cellIndex} className="max-w-64 truncate px-2 py-1" title={row[cellIndex]}>
                  {row[cellIndex] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated || body.length >= TABLE_PREVIEW_ROWS ? <TruncationNote /> : null}
    </div>
  );
}

/**
 * Minimal RFC 4180 field splitter: quoted fields, doubled quotes, delimiters inside
 * quotes. Not a CSV library — enough that a quoted description column does not shatter a
 * preview table into the wrong number of columns.
 */
function splitDelimited(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields;
}

function Loading() {
  return (
    <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading preview…
    </div>
  );
}

function PreviewError({ message }: { message: string }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center">
      <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
      <p className="text-sm font-medium">Preview unavailable</p>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function TruncationNote() {
  return (
    <p className={cn('border-t bg-background/80 px-4 py-2 text-xs text-muted-foreground')}>
      Preview truncated at {formatBytes(TEXT_PREVIEW_BYTES)}. Download the file for the
      complete contents.
    </p>
  );
}

function Fallback({
  title,
  body,
  canDownload,
  downloadUrl,
}: {
  title: string;
  body: string;
  canDownload: boolean;
  downloadUrl: string;
}) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
      <FileWarning className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      {canDownload ? (
        <Button size="sm" asChild>
          <a href={downloadUrl} download>
            <Download className="mr-2 size-4" aria-hidden="true" /> Download
          </a>
        </Button>
      ) : null}
    </div>
  );
}
