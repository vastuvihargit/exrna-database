/**
 * Opening a stored object, whichever provider holds it and whatever has gone wrong with it.
 *
 * `download.service` used to be able to say "resolve the provider, call read". That is
 * still the happy path and still two lines. This module exists for the two cases that
 * appear the moment content actually lives in Google Drive, and that a bare `read()` cannot
 * answer:
 *
 *   1. **A Google-native document has no bytes.** A Doc or a Sheet is not a file with
 *      content; asking Drive for its bytes returns `403 fileNotDownloadable`. It has to be
 *      *exported* to a real format, which changes the content type and the filename
 *      extension the employee receives.
 *
 *   2. **The remote object may be gone.** Someone deleted it in the Drive web UI, or it
 *      aged out of the Drive trash after thirty days. §16 of the brief is explicit about
 *      what must happen, and it is not "500": never delete the record, mark the storage
 *      state, notify an administrator, and — because the local key is never cleared — serve
 *      the retained local copy if it is still there.
 *
 * That last point is the payoff for a decision made three phases ago. `storageKey` staying
 * required and never cleared looked like redundancy; it is what lets an employee keep
 * working through someone else emptying the Shared Drive trash.
 */
import { NotFoundError } from '@/server/errors/app-error';
import { getLogger } from '@/server/logging/logger';
import { getObjectStore } from '@/server/storage';
import { isMissingObjectError } from '@/server/storage/missing-object';
import { GOOGLE_NATIVE_EXPORT_FORMATS } from '@/server/storage/google/drive-client';
import type { GoogleDriveObjectStore } from '@/server/storage/google/google-drive-object-store';
import type { StorageLocator } from '@/server/storage/types';
import type { GoogleNativeKind } from '@/server/db/storage-fields';
import type { VersionStorageLocation } from '@/server/repositories/file-version.repository';
import * as versionRepository from '@/server/repositories/file-version.repository';
import { auditService } from '@/server/audit/audit.service';
import type { Actor } from '@/server/permissions/actor';
import type { RequestMeta } from '@/server/http/request-meta';

export interface OpenedContent {
  body: NodeJS.ReadableStream;
  /**
   * Set when a Google-native document was exported. The caller must use these rather than
   * the stored `mimeType`/extension: what the employee receives is a .docx, not a Doc.
   */
  exported?: { mimeType: string; extension: string };
  /**
   * True when the object was served from the retained local copy because the remote one
   * could not be found. The read succeeded, but something is wrong and has been recorded.
   */
  servedFromLocalFallback: boolean;
  /**
   * True when a range was requested but could not be applied — an export has no stable
   * byte range, so the caller must send the whole body and not claim a partial response.
   */
  rangeIgnored: boolean;
}

/** `document` → `application/vnd.google-apps.document`, which is what the export map keys on. */
function nativeMimeType(kind: GoogleNativeKind): string {
  return `application/vnd.google-apps.${kind}`;
}

/**
 * The format a native document is exported to.
 *
 * One fixed choice per kind rather than a user-facing option, because the alternative is
 * asking a bench scientist to pick between six MIME types on the way to opening a protocol.
 * Office formats are chosen over PDF: they are what people go on to edit.
 */
export function exportFormatFor(kind: GoogleNativeKind): { mimeType: string; extension: string } {
  const format = GOOGLE_NATIVE_EXPORT_FORMATS[nativeMimeType(kind)];
  if (!format) {
    // Unreachable while `GoogleNativeKind` has three members and the map covers all three;
    // asserted rather than assumed, because a silent `undefined` here would produce an
    // export request with no format and a confusing Drive error.
    throw new NotFoundError('This document type cannot be exported');
  }
  return format;
}

export interface OpenInput {
  location: VersionStorageLocation;
  versionId: string;
  fileId: string;
  /** Inclusive byte range, already validated against the object size. */
  range?: { start: number; end: number };
  /** For the audit entry written when a remote object turns out to be missing. */
  displayName?: string;
  /**
   * The request that discovered the problem, when there is one.
   *
   * Optional because some callers are background sweeps with no principal, and inventing a
   * synthetic administrator for those would put a permission-bearing identity into the
   * audit trail that nobody can be held to. Without it the failure is logged and the record
   * still marked — it simply has no actor, which is the truth.
   */
  audit?: { actor: Actor; meta: RequestMeta };
}

/**
 * Streams a version's content.
 *
 * Reads only. It never repairs, re-uploads or deletes anything — a read path that mutated
 * storage would make every download a potential data-loss event. The one write it performs
 * is marking the record as conflicted, which is metadata about the failure, not a fix.
 */
export async function openStoredContent(input: OpenInput): Promise<OpenedContent> {
  const { location } = input;

  if (location.isGoogleNative) {
    return openNativeDocument(input);
  }

  const store = getObjectStore(location.provider);

  try {
    const body = await store.read(
      location,
      input.range ? { range: input.range } : undefined,
    );
    return { body, servedFromLocalFallback: false, rangeIgnored: false };
  } catch (error) {
    if (!isMissingObjectError(error)) throw error;
    return recoverMissingObject(input, error);
  }
}

/**
 * A Doc, Sheet or Slide, converted on the way out.
 *
 * Never has a local fallback: a native document has never had bytes on this server, so
 * there is nothing retained to fall back *to*. If Drive cannot produce it, the honest
 * answer is that it is unavailable.
 */
async function openNativeDocument(input: OpenInput): Promise<OpenedContent> {
  const { location } = input;

  if (location.provider !== 'google_drive' || !location.externalId) {
    throw new NotFoundError('This document is not available');
  }

  const kind = location.googleNativeKind ?? 'document';
  const format = exportFormatFor(kind);
  const store = getObjectStore('google_drive') as GoogleDriveObjectStore;

  try {
    const body = await store.exportNative(location, format.mimeType);
    return {
      body,
      exported: format,
      servedFromLocalFallback: false,
      // An export is generated on demand and has no stable length, so a byte range over it
      // would be meaningless — and answering 206 with a different body than the client
      // asked for is worse than answering 200 with all of it.
      rangeIgnored: input.range !== undefined,
    };
  } catch (error) {
    if (!isMissingObjectError(error)) throw error;
    await flagMissing(input, 'The Google document no longer exists');
    throw new NotFoundError('This document is no longer available. An administrator has been notified.');
  }
}

/**
 * The remote object is gone. Serve the local copy if we still have it.
 *
 * Ordering matters here: the record is marked *before* the fallback is attempted, so a
 * conflict is recorded even if the fallback then also fails. An administrator needs to know
 * about the missing Drive object either way, and the second failure must not swallow the
 * first.
 */
async function recoverMissingObject(input: OpenInput, cause: unknown): Promise<OpenedContent> {
  const { location } = input;

  await flagMissing(
    input,
    location.provider === 'google_drive'
      ? 'The file could not be found in Google Drive'
      : 'The stored file is missing from this server',
  );

  const localCopyUsable =
    location.provider === 'google_drive' && location.localCopyState === 'present';

  if (!localCopyUsable) {
    // Nothing to fall back to. The record survives — only the read fails.
    throw new NotFoundError(
      'The stored content for this file is currently unavailable. An administrator has been notified.',
    );
  }

  // The same key and area the version has always had. This is exactly why `storageKey` is
  // never cleared once an object is copied to Drive.
  const localLocator: StorageLocator = {
    provider: 'local',
    key: location.key,
    area: location.area,
  };

  try {
    const body = await getObjectStore('local').read(
      localLocator,
      input.range ? { range: input.range } : undefined,
    );

    getLogger().warn(
      { versionId: input.versionId, fileId: input.fileId },
      'Served a retained local copy because the Google Drive object was missing',
    );

    return { body, servedFromLocalFallback: true, rangeIgnored: false };
  } catch (fallbackError) {
    // Both failures are logged together: the remote one is the cause, the local one is why
    // there was no way out. Neither message reaches the employee.
    getLogger().error(
      { versionId: input.versionId, fileId: input.fileId, err: fallbackError, cause },
      'Google Drive object missing and the retained local copy could not be read either',
    );
    throw new NotFoundError(
      'The stored content for this file is currently unavailable. An administrator has been notified.',
    );
  }
}

/**
 * Marks the record and writes the audit entry, without ever failing the caller.
 *
 * A read that is otherwise about to succeed from the local copy must not be turned into an
 * error because the *bookkeeping* about the failure failed. The log line is the backstop.
 */
async function flagMissing(input: OpenInput, reason: string): Promise<void> {
  // Always logged, whether or not the rest of the bookkeeping works. This is the line an
  // operator greps for.
  getLogger().error(
    { versionId: input.versionId, fileId: input.fileId, provider: input.location.provider, reason },
    'Stored object is missing',
  );

  try {
    await versionRepository.markStorageConflict(input.versionId, reason);

    if (input.audit) {
      await auditService.recordForActor(input.audit.actor, input.audit.meta, {
        action: 'drive_storage.file_missing',
        entityType: 'file',
        entityId: input.fileId,
        ...(input.displayName ? { entityLabel: input.displayName } : {}),
        newValue: { versionId: input.versionId, reason },
        outcome: 'error',
        severity: 'critical',
      });
    }
  } catch (error) {
    getLogger().error(
      { versionId: input.versionId, err: error },
      'Could not record a missing stored object',
    );
  }
}
