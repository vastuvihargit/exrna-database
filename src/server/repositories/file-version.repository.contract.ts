/**
 * What a file-version repository must do, stated once so two implementations can be held to it.
 *
 * ── The domain, and the two representations of "current" ────────────────────────────────
 *
 * A `File` is the logical research record; a `FileVersion` is one stored revision of it. Google
 * Drive ids belong to *versions*, never to files, because a file that has been re-uploaded four
 * times has four Drive objects and only one of them is current.
 *
 * "Which version is current" is recorded **twice**, and this is not redundancy that can be
 * cleaned up:
 *
 *     files.current_version_id   →  the pointer, read when serving one file
 *     file_versions.is_current   →  the flag, read when listing a file's history
 *
 * Both are load-bearing — the pointer avoids a second query on every file read, the flag avoids
 * a join on every history read — and they must agree. Every write that changes one changes the
 * other, which is precisely why version creation cannot be two independent commits. The same is
 * true of `files.approved_version_id` and `file_versions.is_approved`.
 *
 * ── Why several read shapes rather than one record ──────────────────────────────────────
 *
 * `VersionRecord` is the employee-facing shape and deliberately carries **no storage key, no
 * Drive id and no approval-binding revision**. Callers that genuinely need those use
 * `getStorageLocation`, `findByDriveFileId` or `getApprovalBinding` — separate, awkwardly named
 * calls, so that every code path about to touch storage or to reason about an approval's
 * binding is visible in review rather than implied by a field that happened to be on a record.
 *
 * That separation is inherited from the MongoDB implementation and preserved exactly. Widening
 * `VersionRecord` to "just include the key" would quietly put storage keys into API responses.
 */
import type { ClientSession } from 'mongoose';
import type { StorageArea, StorageLocator, StorageProviderName } from '@/server/storage/types';
import type { GoogleNativeKind, LocalCopyState, SyncStatus } from '@/server/db/storage-fields';
import type { ProcessingStatus, VersionLabel } from '@/server/db/models/file-version.model';

/* ------------------------------------------------------------------ records */

/**
 * A version as an employee may see it.
 *
 * Note what is absent: `storageKey`, `googleDriveFileId`, `approvedRevisionId`. Those identify
 * *where the bytes are* or *what a signature covered*, and neither belongs in a version list.
 */
export interface VersionRecord {
  id: string;
  fileId: string;
  versionNumber: number;
  originalFilename: string;
  fileSize: number;
  mimeType: string;
  extension: string;
  checksumSha256: string;
  uploadedBy: string;
  uploadedAt: Date;
  versionNote: string;
  restoredFromVersionId: string | null;
  processingStatus: string;
  label: string;
  isCurrent: boolean;
  isApproved: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  /**
   * Set when the content this version's approval was granted against has since changed.
   *
   * The revision ids either side of that comparison are deliberately *not* here: what an
   * employee needs is the sentence, not the identifier that produced it.
   */
  approvalSupersededAt: Date | null;
  approvalSupersededReason: string | null;
  previewStatus: string;
  createdAt: Date;
}

/** Where a version's bytes physically are. Returned only by the conspicuous call. */
export interface VersionStorageLocation extends StorageLocator {
  mimeType: string;
  size: number;
  filename: string;
  /**
   * A Google-native document — a Doc, Sheet or Slide. It has no stored bytes at all and cannot
   * be read; it can only be *exported* to a chosen format.
   */
  isGoogleNative: boolean;
  googleNativeKind: GoogleNativeKind | null;
  /** Drive's own URL. On the locator, so it cannot be serialized into a file listing. */
  webViewLink: string | null;
  /**
   * Whether the local copy is still on this server. Carried here because it is what makes a
   * missing Drive object survivable: the local key is never cleared, so a read can fall back.
   */
  localCopyState: LocalCopyState;
}

/**
 * What the Drive change feed needs to decide what an event means for one of our versions.
 *
 * A distinct shape because this is the only caller that starts from a *Drive* id and works
 * backwards, and it needs the stored remote state to compare against.
 */
export interface VersionByDriveId {
  versionId: string;
  fileId: string;
  versionNumber: number;
  isCurrent: boolean;
  isApproved: boolean;
  storageProvider: StorageProviderName;
  googleDriveParentId: string | null;
  googleDriveRevisionId: string | null;
  googleDriveMd5: string | null;
  googleDriveModifiedTime: Date | null;
  isGoogleNative: boolean;
}

/** What an approval on a version was granted against. */
export interface VersionApprovalBinding {
  versionId: string;
  fileId: string;
  versionNumber: number;
  isApproved: boolean;
  approvedAt: Date | null;
  approvedBy: string | null;
  approvedRevisionId: string | null;
  approvedContentModifiedAt: Date | null;
  approvalSupersededAt: Date | null;
}

export interface StoredObjectRef extends StorageLocator {
  versionId: string;
  fileId: string;
  fileSize: number;
  checksumSha256: string;
}

/* ------------------------------------------------------------------ writes */

export interface CreateVersionInput {
  /** Optional so a caller can mint the id first when a storage key must contain it. */
  id?: string;
  organizationId: string;
  fileId: string;
  versionNumber: number;
  storageKey: string;
  storageArea: StorageArea;
  relativeStoragePath: string;
  storedFilename: string;
  originalFilename: string;
  fileSize: number;
  mimeType: string;
  extension: string;
  checksumSha256: string;
  uploadedBy: string;
  versionNote?: string;
  restoredFromVersionId?: string | null;
  /**
   * Where the bytes are, when the caller wrote them somewhere other than local storage. Set by
   * the server-side copy path, which creates its object directly in Drive.
   */
  storageProvider?: 'local' | 'google_drive';
  googleDriveFileId?: string | null;
  googleDriveParentId?: string | null;
  googleDriveRevisionId?: string | null;
  googleDriveMd5?: string | null;
  googleDriveWebViewLink?: string | null;
  /**
   * Only the Drive import sets this, to the source file's modified time. "Uploaded at" for an
   * imported file means when the research happened, not when the migration ran.
   */
  uploadedAt?: Date;
}

/**
 * The fields a version may change after it is written.
 *
 * ── Why this replaced a raw Mongo update document ───────────────────────────────────────
 *
 * `updateFlags` used to take `Record<string, unknown>` and callers passed `{ $set: {...} }`
 * straight through to Mongoose. That is not portable — `$set` means nothing to SQL — and it is
 * not checkable: a misspelled field name silently wrote nothing, and no compiler could say so.
 *
 * Every historical call site set fields from exactly this list and used only `$set`, so nothing
 * is lost by naming them. What is gained is that both implementations write the same columns,
 * and a typo is now a type error.
 *
 * `undefined` means "leave alone"; an explicit `null` means "clear". They are different, and
 * clearing matters — a re-approval must wipe the supersession markers from the previous round.
 */
export interface VersionPatch {
  versionNote?: string;
  label?: VersionLabel;
  processingStatus?: ProcessingStatus;
  previewStatus?: string;
  previewKey?: string | null;

  isApproved?: boolean;
  approvedBy?: string | null;
  approvedAt?: Date | null;
  approvedRevisionId?: string | null;
  approvedContentModifiedAt?: Date | null;
  approvalSupersededAt?: Date | null;
  approvalSupersededReason?: string | null;

  googleDriveRevisionId?: string | null;
  googleDriveModifiedTime?: Date | null;
  googleDriveMd5?: string | null;
  googleDriveWebViewLink?: string | null;

  syncStatus?: SyncStatus;
  lastSyncedAt?: Date | null;
  localCopyState?: LocalCopyState;
}

/**
 * The transaction handle.
 *
 * **MongoDB** — a `ClientSession`, exactly as before.
 *
 * **D1** — there is no interactive transaction and the handle is not honoured. It is not
 * silently ignored either: every D1 mutation here is internally atomic through `db.batch()`,
 * and the one mutation that must span two repositories — creating a version and repointing its
 * file — is composed in `d1-unit-of-work.ts` rather than left to a caller's session.
 */
export type VersionTx = ClientSession | undefined;

/* ------------------------------------------------------------------ the contract */

export interface FileVersionRepository {
  /* -------------------------------------------------- reads */

  /**
   * ⚠️ Carries no authorization of its own, on either engine.
   *
   * A version id is not a capability: whoever may see the *file* may see its versions, and
   * nobody else. This method cannot enforce that, because it does not know the actor — so
   * every user-facing caller reaches it only after `requireFile`, and then checks that the
   * version it got back actually belongs to the file it authorised:
   *
   *     const version = await versionRepository.findById(versionId);
   *     if (!version || version.fileId !== fileId) throw new NotFoundError();
   *
   * That second line is the boundary. Without it a guessed version id from another file — or
   * another organization — would be readable, and the D1 implementation cannot close that hole
   * either. `version.service.ts` and `review.service.ts` both do this today; the D1 test suite
   * asserts the property at the service level rather than here, because here it does not hold.
   */
  findById(id: string): Promise<VersionRecord | null>;

  /** A file's history, newest version first. */
  listForFile(fileId: string): Promise<VersionRecord[]>;

  findCurrent(fileId: string): Promise<VersionRecord | null>;

  /**
   * The number the next version would take.
   *
   * Advisory only. On both engines the authority is the unique index on
   * `(file_id, version_number)`; this is what the caller *proposes*, and a concurrent upload
   * can make it stale between the read and the insert. See `createNextVersion` in the D1
   * unit-of-work, which retries on that collision rather than trusting this number.
   */
  nextVersionNumber(fileId: string): Promise<number>;

  /** ⚠️ Storage keys. Every call site is about to leave metadata and touch bytes. */
  getStorageLocation(versionId: string): Promise<VersionStorageLocation | null>;

  /** ⚠️ Storage keys, for every version of the given files. Used by purge. */
  getStorageLocationsForFiles(fileIds: string[]): Promise<StorageLocator[]>;

  /**
   * ⚠️ Bypass: the Drive change feed, which runs as no user.
   *
   * Ambiguity here must fail loudly rather than pick a version — see the implementations.
   */
  findByDriveFileId(googleDriveFileId: string): Promise<VersionByDriveId | null>;

  /** ⚠️ Bypass: the full reconcile after an expired Drive cursor. Paged by id. */
  listDriveBackedVersions(input: {
    limit: number;
    afterId?: string | null;
  }): Promise<Array<{ versionId: string; fileId: string; googleDriveFileId: string }>>;

  getApprovalBinding(versionId: string): Promise<VersionApprovalBinding | null>;

  /** ⚠️ Bypass: the approval-integrity sweep's work list. Paged by id. */
  listLiveRemoteApprovals(input: {
    limit: number;
    afterId?: string | null;
  }): Promise<VersionApprovalBinding[]>;

  /** ⚠️ Bypass: the storage-integrity sweep's cursor over every stored object. */
  listStoredObjects(input: { afterId?: string; limit: number }): Promise<StoredObjectRef[]>;

  /* -------------------------------------------------- counters, for the admin System page */

  countSyncConflicts(): Promise<number>;
  countLiveRemoteApprovals(): Promise<number>;
  countSupersededApprovals(): Promise<number>;
  countStoredObjects(): Promise<number>;

  /* -------------------------------------------------- writes */

  /** Mints an id before the row exists, because the storage key contains it. */
  newId(): string;

  create(input: CreateVersionInput, tx?: VersionTx): Promise<VersionRecord>;

  /**
   * Makes one version current and demotes the rest.
   *
   * A demoted version keeps its own label unless it was the plain working draft: an approved
   * version that is superseded stays visibly approved in the history, because "which version
   * did they sign?" must remain answerable forever.
   */
  setCurrent(fileId: string, versionId: string, tx?: VersionTx): Promise<void>;

  updateFlags(versionId: string, patch: VersionPatch, tx?: VersionTx): Promise<void>;

  /** Records that a version's stored object disagrees with the database. Never deletes. */
  markStorageConflict(versionId: string, reason: string): Promise<void>;

  /** ⚠️ Bypass: hard delete, from the retention purge. Returns rows actually removed. */
  purgeForFiles(fileIds: string[]): Promise<number>;
}
