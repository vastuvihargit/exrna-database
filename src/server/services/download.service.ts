/**
 * Reading bytes back out (docs/phase-0/06-flows.md, preview and download sequences).
 *
 *   identify version → check permission → resolve location → stream → record
 *
 * This module and `upload.service.ts` are the only two that move file bytes, which is
 * what keeps the "every read is authorized" rule checkable by reading two files.
 *
 * Two invariants shape everything here:
 *
 * 1. The caller never names a storage location. It names a *file*, optionally a version;
 *    the physical key is looked up after permission has been decided, so a manipulated
 *    request can only ever reach a file the user may already read.
 * 2. Nothing physical goes back out. The returned descriptor carries a stream, a size and
 *    a display filename — no key, no path, no area.
 */
import {
  NotFoundError,
  RangeNotSatisfiableError,
  ValidationError,
} from '@/server/errors/app-error';
import { getEnv } from '@/server/config/env';
import { findFileTypeRule, isPreviewable } from '@/server/domain/file-types';
import type { Actor } from '@/server/permissions/actor';
import { auditService } from '@/server/audit/audit.service';
import * as activityRepository from '@/server/repositories/activity.repository';
import * as fileRepository from '@/server/repositories/file.repository';
import * as recentRepository from '@/server/repositories/recent-item.repository';
import * as versionRepository from '@/server/repositories/file-version.repository';
import { contentDisposition } from '@/server/storage/path-safety';
import type { RequestMeta } from '@/server/http/request-meta';
import { requireFile } from './file-access';
import { openStoredContent } from './stored-content';
import { detach } from '@/server/runtime/detach';

/** What the route needs to build a response, and nothing more. */
export interface FileStream {
  body: NodeJS.ReadableStream;
  /**
   * Bytes in this response — the range length when a range was requested.
   *
   * `null` when the length is genuinely unknown, which happens for a Google-native document
   * converted on the way out: its size is not known until the export has been produced.
   * The response then omits `Content-Length` and uses chunked transfer.
   */
  contentLength: number | null;
  /** Total size of the object, for `Content-Range` and `Accept-Ranges`. */
  totalSize: number;
  /** False for content that cannot be range-read, so the client is told not to ask. */
  acceptRanges?: boolean;
  contentType: string;
  contentDisposition: string;
  /** Set when the response is a partial one. */
  range?: { start: number; end: number };
  /** The file's display name, for audit labels. Never a physical name. */
  displayName: string;
  /** Strong-ish validator: the content hash of an immutable object. */
  etag: string;
  fileId: string;
  versionId: string;
  versionNumber: number;
}

export interface ReadOptions {
  /** A specific version. Defaults to the file's current version. */
  versionId?: string;
  /** Raw HTTP `Range` header, if the client sent one. */
  rangeHeader?: string | null;
}

/**
 * Download: always an attachment, always the real bytes.
 *
 * The disposition is `attachment` for every type without exception. A previewable file
 * downloaded through this endpoint is still a download, and letting the browser render
 * an arbitrary uploaded document in our own origin is how a stored SVG or HTML file
 * becomes a script running as the signed-in user.
 */
export async function download(
  actor: Actor,
  fileId: string,
  options: ReadOptions,
  meta: RequestMeta,
): Promise<FileStream> {
  const stream = await open(actor, fileId, 'file.download', options, 'attachment', meta);

  // Counted once per request, including ranged ones: a resumed download is still one
  // download, and the audit trail is what makes "who took this data" answerable.
  await fileRepository.updateById(fileId, { downloadCountDelta: 1 });

  await auditService.recordForActor(actor, meta, {
    action: 'file.download',
    entityType: 'file',
    entityId: fileId,
    entityLabel: stream.displayName,
    newValue: {
      versionId: stream.versionId,
      versionNumber: stream.versionNumber,
      bytes: stream.contentLength,
      partial: Boolean(stream.range),
    },
    severity: 'notice',
  });

  void touchRecent(actor, fileId, 'downloaded');
  return stream;
}

/**
 * Preview: inline, and only for types that are safe to render.
 *
 * The allow-list is the security boundary. `forceDownload` types (SVG, source code) are
 * previewable in the everyday sense but are never served inline, because the browser
 * would execute them in our origin.
 */
export async function preview(
  actor: Actor,
  fileId: string,
  options: ReadOptions,
  meta: RequestMeta,
): Promise<FileStream> {
  const context = await requireFile(actor, fileId, 'file.preview');
  if (!isPreviewable(context.file.extension)) {
    throw new ValidationError(
      `.${context.file.extension} files cannot be previewed in the browser. Download the file instead.`,
      { extension: context.file.extension },
    );
  }

  const stream = await open(actor, fileId, 'file.preview', options, 'inline', meta);

  await auditService.recordForActor(actor, meta, {
    action: 'file.preview',
    entityType: 'file',
    entityId: fileId,
    newValue: { versionId: stream.versionId, versionNumber: stream.versionNumber },
  });

  void touchRecent(actor, fileId, 'previewed');
  detach(
    activityRepository
      .append({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorName: actor.name,
        action: 'file.preview',
        entityType: 'file',
        entityId: fileId,
        entityLabel: context.file.displayName,
        contextFolderIds: context.file.folderPathAncestors,
        departmentId: context.file.departmentId,
        projectId: context.file.projectId,
      }),
    'activity.append',
  );

  return stream;
}

/**
 * Opening a Google Doc, Sheet or Slide in Google's own editor.
 *
 * §11 of the brief asks for this, and it is the one place in the application where a user
 * leaves for Google. Three things make that defensible:
 *
 *   • **The link is never in a response body.** It is resolved server-side after the
 *     permission check and returned as a redirect. A file listing carries no Drive URLs, so
 *     nothing leaks to somebody who merely reads a page's JSON.
 *   • **`file.download` is the permission, not `file.preview`.** The Google editor is an
 *     editor: whoever reaches it can read the whole document and, depending on how the
 *     Shared Drive is shared, change it. That is content access, so it is gated by the
 *     content-access permission.
 *   • **It is off unless the deployment says otherwise.** See
 *     `GOOGLE_DRIVE_NATIVE_EDITOR_ENABLED`. What a person may do once they are inside the
 *     Google editor is governed by Drive, not by this application — an honest boundary, and
 *     one an administrator has to opt into rather than inherit by accident.
 *
 * The access is recorded here, because once the redirect is followed this application stops
 * being able to observe anything at all.
 */
export async function openInGoogleEditor(
  actor: Actor,
  fileId: string,
  options: { versionId?: string },
  meta: RequestMeta,
): Promise<{ url: string; versionId: string; versionNumber: number }> {
  const context = await requireFile(actor, fileId, 'file.download');

  if (!getEnv().GOOGLE_DRIVE_NATIVE_EDITOR_ENABLED) {
    throw new ValidationError(
      'Opening documents in Google has not been switched on for this company. Download the file instead.',
    );
  }

  const version = await resolveVersion(fileId, options.versionId);
  const location = await versionRepository.getStorageLocation(version.id);

  if (!location || !location.isGoogleNative || !location.webViewLink) {
    // Not a native document — there is nothing to open in a Google editor, and inventing a
    // URL from a file id would be a guess this code has no business making.
    throw new ValidationError(
      'This file does not open in a Google editor. Use Preview or Download instead.',
    );
  }

  await auditService.recordForActor(actor, meta, {
    action: 'file.preview',
    entityType: 'file',
    entityId: fileId,
    entityLabel: context.file.displayName,
    newValue: {
      versionId: version.id,
      versionNumber: version.versionNumber,
      openedIn: 'google_editor',
    },
    severity: 'notice',
  });

  void touchRecent(actor, fileId, 'previewed');
  detach(
    activityRepository
      .append({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorName: actor.name,
        action: 'file.preview',
        entityType: 'file',
        entityId: fileId,
        entityLabel: context.file.displayName,
        detail: 'opened in the Google editor',
        contextFolderIds: context.file.folderPathAncestors,
        departmentId: context.file.departmentId,
        projectId: context.file.projectId,
      }),
    'activity.append',
  );

  return { url: location.webViewLink, versionId: version.id, versionNumber: version.versionNumber };
}

/* ---------------------------------------------------------------- internals */

async function open(
  actor: Actor,
  fileId: string,
  permission: 'file.download' | 'file.preview',
  options: ReadOptions,
  disposition: 'inline' | 'attachment',
  meta: RequestMeta,
): Promise<FileStream> {
  const context = await requireFile(actor, fileId, permission);
  const file = context.file;

  const version = await resolveVersion(fileId, options.versionId);
  const location = await versionRepository.getStorageLocation(version.id);
  if (!location) {
    // Metadata exists but the bytes do not: a real fault, reported as a fault rather
    // than as a missing file, because the storage verification job needs to find it.
    throw new NotFoundError('The stored content for this version is missing');
  }

  // A Google-native document has no stored length, so there is no range to satisfy and
  // nothing to validate one against.
  const range = location.isGoogleNative ? null : parseRange(options.rangeHeader, location.size);

  /**
   * The record decides which storage holds these bytes — never the caller, and never a
   * default. `openStoredContent` additionally handles the two things that only exist once
   * content really lives in Drive: a native document has to be exported rather than read,
   * and a remote object that has been deleted falls back to the retained local copy rather
   * than failing (§16). Both are invisible from here, which is the point.
   */
  const opened = await openStoredContent({
    location,
    versionId: version.id,
    fileId,
    ...(range ? { range: { start: range.start, end: range.end } } : {}),
    displayName: file.displayName,
    audit: { actor, meta },
  });

  // An export produced a different format from the one stored, so the extension the
  // employee receives has to match what is actually in the body — handing someone a .docx
  // named `Protocol` with no extension is how a file becomes unopenable.
  const extension = opened.exported?.extension ?? version.extension;

  // The display name is the file's current name with the stored extension, not the
  // physical name. `contentDisposition` sanitizes it and blocks header injection.
  const filename = displayFilename(file.displayName, extension);

  const rule = findFileTypeRule(extension);
  const contentType = opened.exported
    ? opened.exported.mimeType
    : disposition === 'inline' && rule && !rule.forceDownload
      ? version.mimeType
      : // A neutral type on download: the browser must not sniff a stored file into
        // something it will render or execute.
        'application/octet-stream';

  // A range that could not be applied must not be reported as satisfied: answering 206 with
  // the whole body is a lie the client will act on.
  const effectiveRange = opened.rangeIgnored ? null : range;

  return {
    body: opened.body,
    // An export's length is unknown until it exists; `location.size` is 0 for a native
    // document and reporting that would hand the browser an empty file.
    contentLength: opened.exported
      ? null
      : effectiveRange
        ? effectiveRange.end - effectiveRange.start + 1
        : location.size,
    totalSize: location.size,
    acceptRanges: !opened.exported,
    contentType,
    contentDisposition: contentDisposition(filename, disposition),
    ...(effectiveRange ? { range: effectiveRange } : {}),
    displayName: file.displayName,
    /**
     * An exported document has no stable byte-for-byte identity — Google may render the
     * same revision differently between exports — so the validator is the revision it was
     * exported from, not a content hash nothing measured.
     */
    etag: opened.exported
      ? `W/"${location.externalRevisionId ?? version.id}"`
      : `"${version.checksumSha256}"`,
    fileId,
    versionId: version.id,
    versionNumber: version.versionNumber,
  };
}

/**
 * Picks the version to serve and proves it belongs to this file.
 *
 * The ownership check is the whole point: without it, a valid version id from a file the
 * caller *can* read would serve bytes from a file they cannot — permission checked on one
 * object, bytes taken from another.
 */
async function resolveVersion(fileId: string, versionId: string | undefined) {
  if (versionId) {
    const version = await versionRepository.findById(versionId);
    if (!version || version.fileId !== fileId) throw new NotFoundError();
    return version;
  }

  const current = await versionRepository.findCurrent(fileId);
  if (!current) throw new NotFoundError('This file has no stored content');
  return current;
}

function displayFilename(displayName: string, extension: string): string {
  if (!extension) return displayName;
  return displayName.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
    ? displayName
    : `${displayName}.${extension}`;
}

/**
 * Parses a single-range `Range` header.
 *
 * Multi-range requests are declined (by ignoring the header and serving the whole
 * object, which is what RFC 9110 permits) rather than half-implemented: multipart
 * byte-range responses are a lot of machinery for something no media player needs.
 */
export function parseRange(
  header: string | null | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header || size <= 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  const hasStart = rawStart !== '';
  const hasEnd = rawEnd !== '';
  if (!hasStart && !hasEnd) return null;

  let start: number;
  let end: number;

  if (!hasStart) {
    // `bytes=-500` — the final 500 bytes.
    const suffixLength = Number(rawEnd);
    if (suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = hasEnd ? Number(rawEnd) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) {
    // Unsatisfiable. Signalled distinctly so the route answers 416 rather than silently
    // sending the whole file, which would look to the client like a successful seek.
    throw new RangeNotSatisfiableError(size);
  }

  return { start, end: Math.min(end, size - 1) };
}

async function touchRecent(
  actor: Actor,
  fileId: string,
  action: 'downloaded' | 'previewed',
): Promise<void> {
  await recentRepository
    .touch({
      userId: actor.userId,
      organizationId: actor.organizationId,
      entityType: 'file',
      entityId: fileId,
      action,
    })
    .catch(() => undefined);
}

export const downloadService = { download, preview, openInGoogleEditor };
