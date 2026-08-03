/**
 * An in-memory Google Shared Drive.
 *
 * Exists so that everything above the HTTP client — folder adoption, upload verification,
 * locator translation, move semantics, the health check — is tested with **zero network
 * access and no Google account**. That is the whole reason `DriveClient` is an interface;
 * without it none of that logic could be covered in CI, and it is exactly the logic where a
 * mistake silently duplicates a folder or reports a corrupt transfer as verified.
 *
 * The fake is deliberately strict where the real service is strict — it 404s on unknown
 * ids, computes its own MD5 from the bytes it actually received rather than echoing what it
 * was told, and refuses `alt=media` on a Google-native document. A permissive fake would
 * make the provider's error handling untestable, which is the part most worth testing.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  DriveApiError,
  GOOGLE_FOLDER_MIME,
  type DriveChange,
  type DriveChangePage,
  type DriveClient,
  type DriveFileResource,
  type DriveListPage,
  type DriveResource,
  type DriveRevisionResource,
  type DriveUpdateInput,
  type DriveUploadInput,
} from '@/server/storage/google';

/**
 * Module-level, so ids are unique across every instance in a run rather than restarting at
 * 1 for each new fake.
 *
 * A per-instance counter looks harmless until a suite creates a fresh drive per test while
 * the *database* persists across them: the second test then tries to record `drive-item-1`
 * again and trips the unique index on `FileVersion.googleDriveFileId`. That index is doing
 * exactly its job, so the fake is what has to change — real Drive ids are never reused.
 */
let globalSequence = 0;

interface FakeItem {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Buffer | null;
  appProperties: Record<string, string>;
  trashed: boolean;
  createdTime: string;
  modifiedTime: string;
  revision: number;
}

export interface FakeDriveOptions {
  driveId?: string;
  driveName?: string;
  /** `false` models a service account added as a Viewer rather than a Content Manager. */
  canAddChildren?: boolean;
}

export class FakeDriveClient implements DriveClient {
  readonly driveId: string;
  private readonly driveName: string;
  private readonly canAddChildren: boolean;
  private readonly items = new Map<string, FakeItem>();
  private sequence = 0;

  /** Every call made, in order. Lets a test assert that something was *not* called. */
  readonly calls: string[] = [];

  /** Queued failures, keyed by method name, popped one per matching call. */
  private readonly failures = new Map<string, Array<DriveApiError | null>>();

  /**
   * The change feed, as an append-only log with numeric tokens.
   *
   * Modelled as a log rather than as "whatever changed since a timestamp" because that is
   * what Drive is, and because the properties worth testing are log properties: a token
   * consumed twice yields the same page, a token past the end yields nothing, and an
   * *expired* token is a distinct outcome from an empty one. The last is the failure mode
   * that silently desynchronises everything, so it has to be reproducible.
   */
  private readonly changeLog: Array<{ fileId: string; removed: boolean }> = [];
  /** Tokens below this are no longer honoured, modelling Drive expiring a cursor. */
  private expiredBelow = 0;

  constructor(options: FakeDriveOptions = {}) {
    this.driveId = options.driveId ?? 'drive-company';
    this.driveName = options.driveName ?? 'Company Research';
    this.canAddChildren = options.canAddChildren ?? true;
  }

  /* ------------------------------------------------------------ test instrumentation */

  /** Makes the next call to `method` fail with this error. */
  failNext(method: keyof DriveClient, error: DriveApiError): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(error);
    this.failures.set(method, queue);
  }

  /**
   * Lets the next call to `method` through untouched, consuming one slot in the queue.
   *
   * Exists so a test can say "succeed, then fail" — which is how a *partial* application is
   * reproduced, and partial application is the failure mode a naive batch loop produces.
   */
  succeedNext(method: keyof DriveClient): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(null);
    this.failures.set(method, queue);
  }

  private record(method: string): void {
    this.calls.push(method);
    const queue = this.failures.get(method);
    const next = queue?.shift();
    if (next) throw next;
  }

  /** Everything currently in the drive, for assertions about duplicates. */
  snapshot(): Array<{ id: string; name: string; mimeType: string; parents: string[]; trashed: boolean }> {
    return [...this.items.values()].map(({ id, name, mimeType, parents, trashed }) => ({
      id,
      name,
      mimeType,
      parents,
      trashed,
    }));
  }

  contentOf(id: string): Buffer | null {
    return this.items.get(id)?.content ?? null;
  }

  /**
   * Seeds a folder. Omitting `appFolderId` models one a person created by hand — the case
   * that must never be adopted by name.
   */
  seedFolder(input: { name: string; parentId: string; appFolderId?: string }): DriveFileResource {
    return this.toResource(
      this.insert({
        name: input.name,
        mimeType: GOOGLE_FOLDER_MIME,
        parents: [input.parentId],
        content: null,
        appProperties: input.appFolderId ? { appFolderId: input.appFolderId } : {},
      }),
    );
  }

  /** A Google Doc/Sheet/Slide: a real item with a native mime type and no bytes at all. */
  seedNativeDocument(input: {
    name: string;
    parentId: string;
    kind?: 'document' | 'spreadsheet' | 'presentation';
  }): DriveFileResource {
    return this.toResource(
      this.insert({
        name: input.name,
        mimeType: `application/vnd.google-apps.${input.kind ?? 'document'}`,
        parents: [input.parentId],
        content: null,
        appProperties: {},
      }),
    );
  }

  /** Seeds an ordinary binary file, as though a previous migration had put it there. */
  seedFile(input: {
    name: string;
    parentId: string;
    content: Buffer;
    mimeType?: string;
  }): DriveFileResource {
    return this.toResource(
      this.insert({
        name: input.name,
        mimeType: input.mimeType ?? 'application/octet-stream',
        parents: [input.parentId],
        content: input.content,
        appProperties: {},
      }),
    );
  }

  /**
   * Somebody edited the document in the Drive web UI.
   *
   * The only way to reproduce the case §11 of the brief is about — an approved Google Doc
   * whose *content* changes without the application ever being told. Bumping the revision is
   * what the real service does, and it is what the approval check has to notice.
   */
  editInDrive(id: string, content?: Buffer): DriveFileResource {
    const item = this.require(id);
    item.revision += 1;
    item.modifiedTime = new Date(Date.UTC(2026, 5, 1, 0, 0, item.revision)).toISOString();
    if (content !== undefined) item.content = content;
    this.recordChange(id, false);
    return this.toResource(item);
  }

  /** Somebody renamed it in the Drive web UI. */
  renameInDrive(id: string, name: string): DriveFileResource {
    const item = this.require(id);
    item.name = name;
    this.recordChange(id, false);
    return this.toResource(item);
  }

  /** Somebody moved it in the Drive web UI. */
  moveInDrive(id: string, newParentId: string): DriveFileResource {
    const item = this.require(id);
    item.parents = [newParentId];
    this.recordChange(id, false);
    return this.toResource(item);
  }

  /** Somebody put it in the Drive trash — recoverable, unlike a removal. */
  trashInDrive(id: string, trashed = true): DriveFileResource {
    const item = this.require(id);
    item.trashed = trashed;
    this.recordChange(id, false);
    return this.toResource(item);
  }

  /** Gone: emptied from the Drive trash, or deleted outright. */
  removeInDrive(id: string): void {
    this.items.delete(id);
    this.recordChange(id, true);
  }

  /**
   * Drive stops honouring every token issued so far.
   *
   * The condition the whole cursor design exists to survive: the feed has moved past what we
   * last saw, and an unknown set of renames, moves and deletions happened while nobody was
   * looking. Treating that as an empty result is what silently desynchronises everything.
   */
  expireChangeTokens(): void {
    this.expiredBelow = this.changeLog.length + 1;
  }

  private recordChange(fileId: string, removed: boolean): void {
    this.changeLog.push({ fileId, removed });
  }

  /* --------------------------------------------------------------------- internals */

  private insert(input: Omit<FakeItem, 'id' | 'trashed' | 'createdTime' | 'modifiedTime' | 'revision'>): FakeItem {
    this.sequence += 1;
    globalSequence += 1;
    const now = new Date(Date.UTC(2026, 0, 1, 0, 0, this.sequence)).toISOString();
    const item: FakeItem = {
      ...input,
      id: `drive-item-${globalSequence}`,
      trashed: false,
      createdTime: now,
      modifiedTime: now,
      revision: 1,
    };
    this.items.set(item.id, item);
    this.recordChange(item.id, false);
    return item;
  }

  private require(id: string): FakeItem {
    const item = this.items.get(id);
    if (!item) throw new DriveApiError({ status: 404, message: `File not found: ${id}`, reason: 'notFound' });
    return item;
  }

  private toResource(item: FakeItem): DriveFileResource {
    const isFolder = item.mimeType === GOOGLE_FOLDER_MIME;
    const isNative = item.mimeType.startsWith('application/vnd.google-apps.') && !isFolder;

    return {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      parents: [...item.parents],
      // Folders and Google-native documents have no size or MD5 in the real API either.
      ...(isFolder || isNative
        ? {}
        : {
            size: String(item.content?.length ?? 0),
            md5Checksum: createHash('md5')
              .update(item.content ?? Buffer.alloc(0))
              .digest('hex'),
          }),
      // Absent for Google-native documents, exactly as the real API leaves it. A fake that
      // filled this in would make the native change-detection path look like it worked
      // while the production one compared `undefined` against `undefined` forever.
      headRevisionId: isFolder || isNative ? undefined : `rev-${item.id}-${item.revision}`,
      webViewLink: `https://drive.google.com/file/d/${item.id}/view`,
      createdTime: item.createdTime,
      modifiedTime: item.modifiedTime,
      trashed: item.trashed,
      driveId: this.driveId,
      appProperties: { ...item.appProperties },
    };
  }

  /* ------------------------------------------------------------------- DriveClient */

  async getFile(fileId: string): Promise<DriveFileResource> {
    this.record('getFile');
    return this.toResource(this.require(fileId));
  }

  /**
   * Populated for native documents as well as binary ones — which is the whole reason the
   * approval check reads a revision rather than `headRevisionId`.
   */
  async getHeadRevision(fileId: string): Promise<DriveRevisionResource> {
    this.record('getHeadRevision');
    const item = this.require(fileId);

    if (item.mimeType === GOOGLE_FOLDER_MIME) {
      throw new DriveApiError({
        status: 403,
        reason: 'revisionsNotSupported',
        message: 'Revisions are not supported for this file.',
      });
    }

    return {
      id: `rev-${item.id}-${item.revision}`,
      mimeType: item.mimeType,
      modifiedTime: item.modifiedTime,
      ...(item.content
        ? {
            md5Checksum: createHash('md5').update(item.content).digest('hex'),
            size: String(item.content.length),
          }
        : {}),
    };
  }

  async getDrive(driveId: string): Promise<DriveResource> {
    this.record('getDrive');
    if (driveId !== this.driveId) {
      throw new DriveApiError({ status: 404, message: `Shared drive not found: ${driveId}`, reason: 'notFound' });
    }
    return { id: this.driveId, name: this.driveName, capabilities: { canAddChildren: this.canAddChildren } };
  }

  /**
   * Understands only the clauses this codebase actually builds. That is a feature: a query
   * whose shape changes stops matching here, and the folder-adoption test fails rather than
   * silently degrading to "found nothing", which in production means a duplicate folder.
   */
  async listFiles(input: { query: string; pageToken?: string; pageSize?: number }): Promise<DriveListPage> {
    this.record('listFiles');
    const { query } = input;

    const parent = /'([^']+)' in parents/.exec(query)?.[1];
    const mimeType = /mimeType = '([^']+)'/.exec(query)?.[1];
    const propKey = /appProperties has \{ *key='([^']+)'/.exec(query)?.[1];
    const propValue = /value='([^']+)' *\}/.exec(query)?.[1];
    const excludeTrashed = /trashed = false/.test(query);

    const files = [...this.items.values()]
      .filter((item) => (parent ? item.parents.includes(parent) : true))
      .filter((item) => (mimeType ? item.mimeType === mimeType : true))
      .filter((item) => (propKey && propValue ? item.appProperties[propKey] === propValue : true))
      .filter((item) => (excludeTrashed ? !item.trashed : true))
      .map((item) => this.toResource(item));

    return { files: files.slice(0, input.pageSize ?? 100) };
  }

  async createFolder(input: {
    name: string;
    parentId: string;
    appProperties?: Record<string, string>;
  }): Promise<DriveFileResource> {
    this.record('createFolder');
    return this.toResource(
      this.insert({
        name: input.name,
        mimeType: GOOGLE_FOLDER_MIME,
        parents: [input.parentId],
        content: null,
        appProperties: input.appProperties ?? {},
      }),
    );
  }

  async uploadFile(input: DriveUploadInput): Promise<DriveFileResource> {
    this.record('uploadFile');

    const chunks: Buffer[] = [];
    for await (const chunk of input.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    const content = Buffer.concat(chunks);

    if (input.size !== undefined && content.length !== input.size) {
      throw new DriveApiError({
        status: 400,
        message: `Request contains ${content.length} bytes but declared ${input.size}`,
      });
    }

    return this.toResource(
      this.insert({
        name: input.name,
        mimeType: input.mimeType,
        parents: [input.parentId],
        content,
        appProperties: input.appProperties ?? {},
      }),
    );
  }

  async downloadFile(fileId: string, range?: { start: number; end?: number }): Promise<NodeJS.ReadableStream> {
    this.record('downloadFile');
    const item = this.require(fileId);

    if (item.content === null) {
      throw new DriveApiError({
        status: 403,
        reason: 'fileNotDownloadable',
        message: 'Only files with binary content can be downloaded. Use Export with Docs Editors files.',
      });
    }

    const body = range
      ? item.content.subarray(range.start, range.end !== undefined ? range.end + 1 : undefined)
      : item.content;
    return Readable.from([body]);
  }

  async exportFile(fileId: string, mimeType: string): Promise<NodeJS.ReadableStream> {
    this.record('exportFile');
    const item = this.require(fileId);
    return Readable.from([Buffer.from(`exported:${item.id}:${mimeType}`)]);
  }

  async updateFile(fileId: string, changes: DriveUpdateInput): Promise<DriveFileResource> {
    this.record('updateFile');
    const item = this.require(fileId);

    if (changes.name !== undefined) item.name = changes.name;
    if (changes.trashed !== undefined) item.trashed = changes.trashed;

    if (changes.removeParents) {
      const removed = new Set(changes.removeParents.split(','));
      item.parents = item.parents.filter((parent) => !removed.has(parent));
    }
    if (changes.addParents) {
      for (const parent of changes.addParents.split(',')) {
        if (!item.parents.includes(parent)) item.parents.push(parent);
      }
    }

    item.revision += 1;
    item.modifiedTime = new Date(Date.UTC(2026, 0, 2, 0, 0, item.revision)).toISOString();
    this.recordChange(fileId, false);
    return this.toResource(item);
  }

  async copyFile(fileId: string, input: { name: string; parentId: string }): Promise<DriveFileResource> {
    this.record('copyFile');
    const source = this.require(fileId);
    return this.toResource(
      this.insert({
        name: input.name,
        mimeType: source.mimeType,
        parents: [input.parentId],
        content: source.content ? Buffer.from(source.content) : null,
        appProperties: {},
      }),
    );
  }

  async deleteFile(fileId: string): Promise<void> {
    this.record('deleteFile');
    // Idempotent, exactly like the real client's 404-tolerant DELETE.
    this.items.delete(fileId);
    this.recordChange(fileId, true);
  }

  /* ------------------------------------------------------------------- changes */

  async getStartPageToken(): Promise<string> {
    this.record('getStartPageToken');
    // "Everything from here on": the next entry that will be written to the log.
    return String(this.changeLog.length + 1);
  }

  async listChanges(input: { pageToken: string; pageSize?: number }): Promise<DriveChangePage> {
    this.record('listChanges');

    const from = Number(input.pageToken);
    if (!Number.isFinite(from) || from < 1) {
      throw new DriveApiError({ status: 400, message: 'Invalid page token', reason: 'invalid' });
    }
    if (from < this.expiredBelow) {
      // The real API's answer to a cursor it no longer honours. Not an empty page.
      throw new DriveApiError({
        status: 404,
        reason: 'notFound',
        message: 'Start page token is no longer valid.',
      });
    }

    const pageSize = input.pageSize ?? 100;
    const slice = this.changeLog.slice(from - 1, from - 1 + pageSize);

    const changes: DriveChange[] = slice.map((entry, index) => {
      const item = this.items.get(entry.fileId);
      return {
        fileId: entry.fileId,
        driveId: this.driveId,
        time: new Date(Date.UTC(2026, 5, 2, 0, 0, from + index)).toISOString(),
        // `removed` is reported when the object is gone, whether the log entry said so or a
        // later removal took it — the real feed describes the world now, not then.
        ...(entry.removed || !item ? { removed: true } : { file: this.toResource(item) }),
      };
    });

    const next = from + slice.length;
    return {
      changes,
      // A short page means the caller has caught up, and only then is a new start token
      // issued — exactly the contract that makes "commit the cursor once, at the end" safe.
      ...(slice.length === pageSize && next <= this.changeLog.length
        ? { nextPageToken: String(next) }
        : { newStartPageToken: String(this.changeLog.length + 1) }),
    };
  }
}

