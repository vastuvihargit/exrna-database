/**
 * The one place this application speaks HTTP to Google Drive.
 *
 * No route, service or repository issues a Drive request. Everything goes through the
 * `DriveClient` interface, which exists so that the provider above it — the folder
 * adoption, the verification, the locator translation — is testable against an in-memory
 * fake with zero network access, and so that a future change to authentication, retry
 * policy or API version has exactly one place to happen.
 *
 * Scope of this module: shape requests, apply auth, classify failures, retry the transient
 * ones, and stream. It knows nothing about `FileVersion`, folders-as-database-rows,
 * permissions or checksum policy. Those all live above it.
 */
import { Readable } from 'stream';
import { StorageError } from '@/server/errors/app-error';
import type { AccessTokenSource } from './drive-auth';
import type { DriveStorageConfig } from './drive-config';
import {
  backoffDelayMs,
  DriveApiError,
  driveErrorFromResponse,
  isAuthFailure,
  withDriveRetry,
  type RetryOptions,
} from './drive-errors';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Google-native documents hold no bytes of their own and can only be *exported*.
 * Anything native that is not in this map is reported as unsupported, never guessed at.
 */
export const GOOGLE_NATIVE_EXPORT_FORMATS: Record<string, { mimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: 'pptx',
  },
};

export function isGoogleNativeMimeType(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.') && mimeType !== GOOGLE_FOLDER_MIME;
}

/** The field set requested for every file. Kept in one constant so responses are uniform. */
export const DRIVE_FILE_FIELDS =
  'id,name,mimeType,parents,size,md5Checksum,headRevisionId,webViewLink,createdTime,modifiedTime,trashed,driveId,appProperties';

export interface DriveFileResource {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  /** A string in the API: file sizes exceed the JSON-safe integer range. */
  size?: string;
  md5Checksum?: string;
  headRevisionId?: string;
  webViewLink?: string;
  createdTime?: string;
  modifiedTime?: string;
  trashed?: boolean;
  driveId?: string;
  appProperties?: Record<string, string>;
}

export interface DriveResource {
  id: string;
  name: string;
  capabilities?: Record<string, boolean>;
}

/**
 * One entry in Drive's change feed.
 *
 * `removed` and `file.trashed` are different events and this codebase treats them
 * differently: trashed is recoverable and mirrors into the application's own trash, removed
 * means the object is gone and — per §16 of the brief — must never silently delete a record.
 *
 * `file` is absent when `removed` is true: there is nothing left to describe.
 */
export interface DriveChange {
  fileId: string;
  removed?: boolean;
  time?: string;
  driveId?: string;
  file?: DriveFileResource;
}

export interface DriveChangePage {
  changes: DriveChange[];
  nextPageToken?: string;
  /**
   * Present only on the final page. Storing it is what makes the next poll incremental; a
   * poll that replayed from the old token would re-apply everything it had already applied.
   */
  newStartPageToken?: string;
}

/** The field set requested for a revision. Small on purpose: this is polled, not browsed. */
export const DRIVE_REVISION_FIELDS = 'id,mimeType,modifiedTime,md5Checksum,size';

/**
 * One revision of a file.
 *
 * This exists because of an asymmetry in the Drive API that the approval design depends on:
 * `files.get` populates `headRevisionId` **only for files with binary content**, and leaves
 * it absent for Google Docs, Sheets and Slides. Binding an approval to `headRevisionId`
 * would therefore bind native documents — the ones most likely to be edited in place, and
 * the exact case §11 of the brief is about — to `undefined`, and every comparison would
 * read as "unchanged" forever.
 *
 * `revisions.get(fileId, 'head')` is populated for both, so it is what the approval binds
 * to. `md5Checksum` and `size` are present only for binary revisions; that is expected and
 * the caller treats them as optional corroboration, never as the identity.
 */
export interface DriveRevisionResource {
  id: string;
  mimeType?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
}

export interface DriveListPage {
  files: DriveFileResource[];
  nextPageToken?: string;
}

export interface DriveUploadInput {
  name: string;
  parentId: string;
  mimeType: string;
  body: NodeJS.ReadableStream;
  /** Exact byte length when known. Enables a total in `Content-Range` and a size check. */
  size?: number;
  /**
   * Written onto the Drive object itself. The migration stamps an idempotency key here so
   * a file orphaned by a crash between "Drive committed" and "MongoDB committed" can be
   * found and adopted rather than uploaded a second time.
   */
  appProperties?: Record<string, string>;
}

export interface DriveUpdateInput {
  name?: string;
  addParents?: string;
  removeParents?: string;
  trashed?: boolean;
}

export interface DriveClient {
  getFile(fileId: string): Promise<DriveFileResource>;
  /** The current revision of a file, native or binary. See `DriveRevisionResource`. */
  getHeadRevision(fileId: string): Promise<DriveRevisionResource>;
  /** A cursor into the change feed, as of now. */
  getStartPageToken(): Promise<string>;
  /** Everything that has changed since the token. */
  listChanges(input: { pageToken: string; pageSize?: number }): Promise<DriveChangePage>;
  listFiles(input: { query: string; pageToken?: string; pageSize?: number }): Promise<DriveListPage>;
  createFolder(input: {
    name: string;
    parentId: string;
    appProperties?: Record<string, string>;
  }): Promise<DriveFileResource>;
  uploadFile(input: DriveUploadInput): Promise<DriveFileResource>;
  downloadFile(fileId: string, range?: { start: number; end?: number }): Promise<NodeJS.ReadableStream>;
  exportFile(fileId: string, mimeType: string): Promise<NodeJS.ReadableStream>;
  updateFile(fileId: string, changes: DriveUpdateInput): Promise<DriveFileResource>;
  copyFile(fileId: string, input: { name: string; parentId: string }): Promise<DriveFileResource>;
  deleteFile(fileId: string): Promise<void>;
  getDrive(driveId: string): Promise<DriveResource>;
}

/**
 * A Drive id inside a `q` expression sits in single quotes. Real ids are base64url-ish and
 * contain neither quote nor backslash, but the escape is applied rather than assumed — the
 * same rule this codebase applies to every other query it builds.
 */
export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

interface RequestOptions {
  method: string;
  url: string;
  /** JSON body. Mutually exclusive with `rawBody`. */
  json?: unknown;
  rawBody?: Buffer;
  headers?: Record<string, string>;
  /**
   * `headers` stops the timeout once response headers arrive, so a slow-but-progressing
   * multi-gigabyte download is not aborted at the two-minute mark. `full` keeps it running
   * through body consumption, which is right for the small JSON responses.
   */
  timeoutScope?: 'full' | 'headers';
  /** Statuses that are an expected outcome rather than a failure (e.g. 308, 404). */
  expect?: (status: number) => boolean;
}

export class GoogleDriveHttpClient implements DriveClient {
  constructor(
    private readonly config: DriveStorageConfig,
    private readonly tokens: AccessTokenSource,
    /** Overridden in tests to make backoff instantaneous and deterministic. */
    private readonly retryOptions: RetryOptions = {},
  ) {}

  /* ------------------------------------------------------------------ transport */

  private async send(options: RequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.tokens.getAccessToken()}`,
      ...options.headers,
    };

    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      body = JSON.stringify(options.json);
    } else if (options.rawBody) {
      // Cast because Node's fetch accepts a Buffer but the DOM typings describe only the
      // ArrayBuffer view it is backed by.
      body = options.rawBody as unknown as BodyInit;
    }

    let response: Response;
    try {
      response = await fetch(options.url, {
        method: options.method,
        headers,
        body,
        signal: controller.signal,
        cache: 'no-store',
        // Redirects are followed by default and Drive uses them for downloads.
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        // Surfaced as a 504 so the retry classifier treats it as transient: a timeout is
        // very often a slow network rather than a broken request.
        throw new DriveApiError({ status: 504, message: 'The Google Drive request timed out' });
      }
      throw new DriveApiError({
        status: 503,
        message: error instanceof Error ? error.message : 'Google Drive could not be reached',
      });
    }

    // Headers have arrived. For a streaming read that is where the timeout's job ends: the
    // body may legitimately take far longer than `requestTimeoutMs` to transfer, and
    // aborting a working multi-gigabyte download at the two-minute mark would be a bug
    // dressed as a safety measure. For everything else the body is a small JSON document,
    // so the timer stays armed until it has been consumed.
    if (options.timeoutScope === 'headers') clearTimeout(timer);

    try {
      const acceptable = options.expect ?? ((status: number) => status >= 200 && status < 300);
      if (!acceptable(response.status)) {
        const text = await response.text().catch(() => '');
        throw driveErrorFromResponse(response.status, text, response.headers.get('retry-after'));
      }
      return response;
    } finally {
      if (options.timeoutScope !== 'headers') clearTimeout(timer);
    }
  }

  /**
   * A request that can be retried in full.
   *
   * Only safe for calls with no streaming body — a consumed stream cannot be replayed, so
   * uploads do their own chunk-level retry instead (see `uploadFile`).
   */
  private async sendWithRetry(options: RequestOptions): Promise<Response> {
    return withDriveRetry(() => this.send(options), {
      ...this.retryOptions,
      onRetry: async (error, attempt) => {
        // A 401 means the token died before its stated expiry — revoked key, clock jump.
        // Throwing it away is the only thing that makes the retry different from the
        // attempt that just failed.
        if (error.status === 401) this.tokens.invalidate();
        await this.retryOptions.onRetry?.(error, attempt);
      },
    });
  }

  private async json<T>(options: RequestOptions): Promise<T> {
    const response = await this.sendWithRetry({ ...options, timeoutScope: 'full' });
    return (await response.json()) as T;
  }

  private url(path: string, params: Record<string, string | undefined>, base = DRIVE_API): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, value);
    }
    return `${base}${path}?${search.toString()}`;
  }

  /* ------------------------------------------------------------------ metadata */

  async getFile(fileId: string): Promise<DriveFileResource> {
    return this.json<DriveFileResource>({
      method: 'GET',
      url: this.url(`/files/${encodeURIComponent(fileId)}`, {
        fields: DRIVE_FILE_FIELDS,
        supportsAllDrives: 'true',
      }),
    });
  }

  /**
   * The head revision, which is what an approval is bound to.
   *
   * `head` is a documented alias for "the current revision", so this is one request rather
   * than listing every revision a document has ever had and taking the last — a Doc that has
   * been edited for a year has thousands, and paging through them to answer "has it changed
   * since Tuesday?" would be absurd.
   */
  async getHeadRevision(fileId: string): Promise<DriveRevisionResource> {
    return this.json<DriveRevisionResource>({
      method: 'GET',
      url: this.url(`/files/${encodeURIComponent(fileId)}/revisions/head`, {
        fields: DRIVE_REVISION_FIELDS,
      }),
    });
  }

  /**
   * Always scoped to the configured Shared Drive.
   *
   * `corpora=drive` with an explicit `driveId` is what stops a query from ever reaching
   * outside it. A search that silently fell back to the service account's own (empty) My
   * Drive would return nothing and read as "the file does not exist" — which, for the
   * folder-adoption path, means creating a duplicate.
   */
  async listFiles(input: { query: string; pageToken?: string; pageSize?: number }): Promise<DriveListPage> {
    return this.json<DriveListPage>({
      method: 'GET',
      url: this.url('/files', {
        q: input.query,
        fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
        pageSize: String(input.pageSize ?? 100),
        pageToken: input.pageToken,
        corpora: 'drive',
        driveId: this.config.sharedDriveId,
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      }),
    });
  }

  /* -------------------------------------------------------------------- changes */

  /**
   * A cursor into the change feed, as of now.
   *
   * Scoped to the configured Shared Drive. A token taken without `driveId` is a cursor into
   * the service account's own (empty) My Drive, which would poll cleanly forever and report
   * nothing — the most expensive possible way to be wrong.
   */
  async getStartPageToken(): Promise<string> {
    const result = await this.json<{ startPageToken: string }>({
      method: 'GET',
      url: this.url('/changes/startPageToken', {
        driveId: this.config.sharedDriveId,
        supportsAllDrives: 'true',
      }),
    });
    return result.startPageToken;
  }

  /**
   * Everything that has changed since `pageToken`.
   *
   * `restrictToMyDrive` is deliberately absent and `includeItemsFromAllDrives` deliberately
   * true: without them a Shared Drive's changes are simply not in the feed.
   *
   * A `404` here means Drive no longer recognises the token — the feed has moved past what
   * we last saw. That is emphatically *not* "no changes", and the caller treats it as a
   * demand for a full reconcile rather than as an empty page.
   */
  async listChanges(input: { pageToken: string; pageSize?: number }): Promise<DriveChangePage> {
    return this.json<DriveChangePage>({
      method: 'GET',
      url: this.url('/changes', {
        pageToken: input.pageToken,
        driveId: this.config.sharedDriveId,
        pageSize: String(input.pageSize ?? 100),
        spaces: 'drive',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        includeRemoved: 'true',
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,time,driveId,file(${DRIVE_FILE_FIELDS}))`,
      }),
    });
  }

  async getDrive(driveId: string): Promise<DriveResource> {
    return this.json<DriveResource>({
      method: 'GET',
      url: this.url(`/drives/${encodeURIComponent(driveId)}`, { fields: 'id,name,capabilities' }),
    });
  }

  /* ------------------------------------------------------------------ mutations */

  async createFolder(input: {
    name: string;
    parentId: string;
    appProperties?: Record<string, string>;
  }): Promise<DriveFileResource> {
    return this.json<DriveFileResource>({
      method: 'POST',
      url: this.url('/files', { fields: DRIVE_FILE_FIELDS, supportsAllDrives: 'true' }),
      json: {
        name: input.name,
        mimeType: GOOGLE_FOLDER_MIME,
        parents: [input.parentId],
        ...(input.appProperties ? { appProperties: input.appProperties } : {}),
      },
    });
  }

  async updateFile(fileId: string, changes: DriveUpdateInput): Promise<DriveFileResource> {
    const metadata: Record<string, unknown> = {};
    if (changes.name !== undefined) metadata.name = changes.name;
    if (changes.trashed !== undefined) metadata.trashed = changes.trashed;

    return this.json<DriveFileResource>({
      method: 'PATCH',
      url: this.url(`/files/${encodeURIComponent(fileId)}`, {
        fields: DRIVE_FILE_FIELDS,
        supportsAllDrives: 'true',
        addParents: changes.addParents,
        removeParents: changes.removeParents,
      }),
      json: metadata,
    });
  }

  async copyFile(fileId: string, input: { name: string; parentId: string }): Promise<DriveFileResource> {
    return this.json<DriveFileResource>({
      method: 'POST',
      url: this.url(`/files/${encodeURIComponent(fileId)}/copy`, {
        fields: DRIVE_FILE_FIELDS,
        supportsAllDrives: 'true',
      }),
      json: { name: input.name, parents: [input.parentId] },
    });
  }

  /**
   * Permanent deletion, bypassing the Drive trash.
   *
   * Only ever called on an object the application knows it just created and failed to
   * record — a failed-verification upload, or a rollback of a transfer. Deleting user
   * content is `updateFile(trashed: true)`, which is recoverable.
   */
  async deleteFile(fileId: string): Promise<void> {
    await this.sendWithRetry({
      method: 'DELETE',
      url: this.url(`/files/${encodeURIComponent(fileId)}`, { supportsAllDrives: 'true' }),
      timeoutScope: 'full',
      // Already gone is the desired end state. Deletion is idempotent everywhere in this
      // codebase, and a retry whose first attempt actually succeeded must not fail.
      expect: (status) => (status >= 200 && status < 300) || status === 404,
    });
  }

  /* ------------------------------------------------------------------ content */

  async downloadFile(fileId: string, range?: { start: number; end?: number }): Promise<NodeJS.ReadableStream> {
    const headers: Record<string, string> = {};
    if (range) {
      headers.Range = `bytes=${range.start}-${range.end !== undefined ? range.end : ''}`;
    }

    const response = await this.sendWithRetry({
      method: 'GET',
      url: this.url(`/files/${encodeURIComponent(fileId)}`, {
        alt: 'media',
        supportsAllDrives: 'true',
      }),
      headers,
      // Cleared at headers: the body may legitimately take far longer than the request
      // timeout to transfer, and aborting a working 4 GB download at two minutes would be
      // a bug, not a safety measure.
      timeoutScope: 'headers',
      expect: (status) => status === 200 || status === 206,
    });

    return toNodeStream(response);
  }

  async exportFile(fileId: string, mimeType: string): Promise<NodeJS.ReadableStream> {
    const response = await this.sendWithRetry({
      method: 'GET',
      url: this.url(`/files/${encodeURIComponent(fileId)}/export`, { mimeType }),
      timeoutScope: 'headers',
    });
    return toNodeStream(response);
  }

  /**
   * Resumable upload.
   *
   * Resumable rather than multipart for every size, not just large files, because the
   * property that matters is not chunking — it is that an interrupted transfer can be
   * *queried* for how many bytes the server actually received and continued from there.
   * A simple upload that fails at 90% has to start again from zero and has no way to tell
   * whether the file was created.
   *
   * Memory is bounded by one chunk (`GOOGLE_DRIVE_UPLOAD_CHUNK_MB`, default 16 MB)
   * regardless of file size: bytes are pulled from the source stream a chunk at a time and
   * the buffer is released as soon as Drive acknowledges it.
   */
  async uploadFile(input: DriveUploadInput): Promise<DriveFileResource> {
    const sessionUri = await this.createUploadSession(input);
    const reader = new ChunkReader(input.body, this.config.uploadChunkBytes);

    let offset = 0;
    let result: DriveFileResource | null = null;

    for (;;) {
      const chunk = await reader.next();

      // The source ended on an exact chunk boundary — or carried nothing at all. Either
      // way the session is still open, and a zero-length request stating the final total
      // is what closes it. Without this a file whose size is a multiple of the chunk size
      // would upload every byte and then never be created.
      if (chunk.length === 0) {
        result = await this.finalizeUpload(sessionUri, offset);
        break;
      }

      const isFinal = reader.exhausted;
      // When the size is known it is declared on every chunk, which is the ordinary path
      // and lets Drive reject a mismatch itself. When it is not, only the final chunk can
      // state the total.
      const total = input.size !== undefined ? input.size : isFinal ? offset + chunk.length : undefined;

      const outcome = await this.putChunk(sessionUri, chunk, offset, total);
      offset += chunk.length;

      if (outcome) {
        result = outcome;
        break;
      }
    }

    if (!result) {
      throw new StorageError('STORAGE_ERROR', 'The Google Drive upload finished without returning a file');
    }

    if (input.size !== undefined && offset !== input.size) {
      // The stream disagreed with its declared length. The partial object is removed rather
      // than left addressable: a truncated file is not a smaller file, it is a corrupt one,
      // and the local provider already refuses exactly this.
      await this.deleteFile(result.id).catch(() => {});
      throw new StorageError(
        'STORAGE_ERROR',
        `The upload stream carried ${offset} bytes but ${input.size} were expected`,
      );
    }

    return result;
  }

  private async createUploadSession(input: DriveUploadInput): Promise<string> {
    const headers: Record<string, string> = { 'X-Upload-Content-Type': input.mimeType };
    if (input.size !== undefined) headers['X-Upload-Content-Length'] = String(input.size);

    const response = await this.sendWithRetry({
      method: 'POST',
      url: this.url(
        '/files',
        { uploadType: 'resumable', supportsAllDrives: 'true', fields: DRIVE_FILE_FIELDS },
        DRIVE_UPLOAD_API,
      ),
      headers,
      json: {
        name: input.name,
        parents: [input.parentId],
        mimeType: input.mimeType,
        ...(input.appProperties ? { appProperties: input.appProperties } : {}),
      },
      timeoutScope: 'full',
    });

    const location = response.headers.get('location');
    if (!location) {
      throw new StorageError('STORAGE_ERROR', 'Google Drive did not return a resumable upload session');
    }
    return location;
  }

  /**
   * One chunk, retried on its own.
   *
   * The chunk is already buffered, so unlike a whole-request retry this one can genuinely
   * replay. Before each retry the session is asked how many bytes it actually holds: a
   * failure *after* Drive committed the chunk but before the response reached us would
   * otherwise re-send bytes at the wrong offset and corrupt the object.
   */
  private async putChunk(
    sessionUri: string,
    chunk: Buffer,
    offset: number,
    total: number | undefined,
  ): Promise<DriveFileResource | null> {
    const attempts = this.retryOptions.attempts ?? 5;
    const sleep = this.retryOptions.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) {
        // Ask the session what it actually holds before re-sending. A failure *after* Drive
        // committed the chunk but before its response reached us is indistinguishable from
        // one where nothing arrived — and blindly replaying would write these bytes at an
        // offset Drive has already filled. This is the check that makes a retry safe rather
        // than merely likely to work.
        const status = await this.queryUploadStatus(sessionUri, total);
        if (status.file) return status.file;
        if (status.receivedBytes >= offset + chunk.length) return null;
        if (status.receivedBytes !== offset) {
          throw new StorageError(
            'STORAGE_ERROR',
            `The Google Drive upload session holds ${status.receivedBytes} bytes but this chunk starts at ${offset}`,
          );
        }
      }

      try {
        const response = await this.send({
          method: 'PUT',
          url: sessionUri,
          rawBody: chunk,
          headers: { 'Content-Range': `bytes ${offset}-${offset + chunk.length - 1}/${total ?? '*'}` },
          timeoutScope: 'full',
          // 308 "Resume Incomplete" is the success signal for every chunk but the last.
          expect: (status) => status === 200 || status === 201 || status === 308,
        });

        if (response.status === 308) return null;
        return (await response.json()) as DriveFileResource;
      } catch (error) {
        lastError = error;
        const driveError = error instanceof DriveApiError ? error : null;
        const canRetry = driveError ? driveError.retryable || isAuthFailure(driveError.status) : false;
        if (!canRetry || attempt === attempts) throw error;

        if (isAuthFailure(driveError!.status)) {
          this.tokens.invalidate();
        } else {
          const delay =
            driveError!.retryAfterSeconds !== null
              ? driveError!.retryAfterSeconds * 1000
              : backoffDelayMs(attempt, this.retryOptions);
          if (delay > 0) await sleep(delay);
        }
        await this.retryOptions.onRetry?.(driveError!, attempt);
      }
    }

    throw lastError;
  }

  /**
   * How many bytes the session already holds, per Drive itself.
   *
   * A 200/201 here means the upload is already complete — which happens when the response
   * to the final chunk was lost in transit. Returning the resource rather than re-sending
   * is what stops a network blip at 99% from producing a duplicate file.
   */
  private async queryUploadStatus(
    sessionUri: string,
    total: number | undefined,
  ): Promise<{ file: DriveFileResource | null; receivedBytes: number }> {
    const response = await this.send({
      method: 'PUT',
      url: sessionUri,
      headers: { 'Content-Range': `bytes */${total ?? '*'}` },
      timeoutScope: 'full',
      expect: (status) => status === 200 || status === 201 || status === 308,
    });

    if (response.status !== 308) {
      return { file: (await response.json()) as DriveFileResource, receivedBytes: total ?? 0 };
    }

    // `Range: bytes=0-262143` means 262144 bytes are held. An absent header means none are,
    // which is the documented representation of an empty session.
    const range = response.headers.get('range');
    const lastByte = range ? Number.parseInt(range.slice(range.indexOf('-') + 1), 10) : NaN;
    return { file: null, receivedBytes: Number.isFinite(lastByte) ? lastByte + 1 : 0 };
  }

  /**
   * Closes a session whose source stream ended on a chunk boundary.
   *
   * `bytes * /total` with an empty body is Drive's documented way to say "that was all of
   * it, and the total is this" — the same request shape as a status query, which is why a
   * 308 response here means Drive disagrees about how much it received.
   */
  private async finalizeUpload(sessionUri: string, totalBytes: number): Promise<DriveFileResource> {
    const status = await withDriveRetry(() => this.queryUploadStatus(sessionUri, totalBytes), {
      ...this.retryOptions,
      onRetry: (error) => {
        if (error.status === 401) this.tokens.invalidate();
      },
    });

    if (!status.file) {
      throw new StorageError(
        'STORAGE_ERROR',
        `The Google Drive upload session holds ${status.receivedBytes} of ${totalBytes} bytes and did not complete`,
      );
    }
    return status.file;
  }
}

/**
 * Pulls fixed-size chunks out of a Node stream.
 *
 * Written by hand rather than with a Transform because the upload loop needs *pull*
 * semantics — it must hold each chunk until Drive acknowledges it, and a push-based
 * pipeline would keep producing while a retry is in flight, defeating the bounded-memory
 * guarantee that is the whole point of chunking.
 */
class ChunkReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffer: Buffer[] = [];
  private buffered = 0;
  private done = false;

  constructor(source: NodeJS.ReadableStream, private readonly chunkSize: number) {
    this.iterator = (source as unknown as AsyncIterable<Buffer | string>)[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  /** True once the source has ended and everything read from it has been returned. */
  get exhausted(): boolean {
    return this.done && this.buffered === 0;
  }

  async next(): Promise<Buffer> {
    while (this.buffered < this.chunkSize && !this.done) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.done = true;
        break;
      }
      const piece = Buffer.isBuffer(value) ? value : Buffer.from(value as unknown as string);
      this.buffer.push(piece);
      this.buffered += piece.length;
    }

    if (this.buffered === 0) return Buffer.alloc(0);

    const joined = Buffer.concat(this.buffer, this.buffered);
    const take = Math.min(this.chunkSize, joined.length);
    const chunk = joined.subarray(0, take);
    const rest = joined.subarray(take);

    this.buffer = rest.length > 0 ? [rest] : [];
    this.buffered = rest.length;

    return chunk;
  }
}

async function toNodeStream(response: Response): Promise<NodeJS.ReadableStream> {
  if (!response.body) {
    throw new StorageError('STORAGE_ERROR', 'Google Drive returned an empty response body');
  }
  return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
}
