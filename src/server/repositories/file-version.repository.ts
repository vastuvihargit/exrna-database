/**
 * Version persistence — the only place storage keys are read.
 *
 * `VersionRecord` omits the key entirely. Callers that genuinely need it (download,
 * preview, purge) use `getStorageLocation`, which is deliberately a separate,
 * awkwardly-named function so that it is obvious in review when a code path is about to
 * touch the filesystem.
 */
import { Types, type ClientSession, type FilterQuery } from 'mongoose';
import { connectToDatabase } from '@/server/db/connection';
import { FileVersionModel, type FileVersionDocument } from '@/server/db/models';
import type { StorageArea, StorageLocator, StorageProviderName } from '@/server/storage/types';
import type { GoogleNativeKind, LocalCopyState } from '@/server/db/storage-fields';

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
   * The revision ids either side of that comparison are deliberately *not* on this record:
   * §19 of the brief keeps revision identifiers out of the employee-facing surface, and what
   * an employee needs is the sentence, not the identifier that produced it.
   */
  approvalSupersededAt: Date | null;
  approvalSupersededReason: string | null;
  previewStatus: string;
  createdAt: Date;
}

type LeanVersion = FileVersionDocument & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

function isValidId(value: string): boolean {
  return Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value);
}

function toRecord(doc: LeanVersion): VersionRecord {
  return {
    id: String(doc._id),
    fileId: String(doc.fileId),
    versionNumber: doc.versionNumber,
    originalFilename: doc.originalFilename,
    fileSize: doc.fileSize,
    mimeType: doc.mimeType,
    extension: doc.extension,
    checksumSha256: doc.checksumSha256,
    uploadedBy: String(doc.uploadedBy),
    uploadedAt: doc.uploadedAt ?? doc.createdAt,
    versionNote: doc.versionNote ?? '',
    restoredFromVersionId: doc.restoredFromVersionId ? String(doc.restoredFromVersionId) : null,
    processingStatus: doc.processingStatus ?? 'pending',
    label: doc.label ?? 'draft',
    isCurrent: Boolean(doc.isCurrent),
    isApproved: Boolean(doc.isApproved),
    approvedBy: doc.approvedBy ? String(doc.approvedBy) : null,
    approvedAt: doc.approvedAt ?? null,
    approvalSupersededAt: doc.approvalSupersededAt ?? null,
    approvalSupersededReason: doc.approvalSupersededReason ?? null,
    previewStatus: doc.previewStatus ?? 'none',
    createdAt: doc.createdAt,
  };
}

export async function findById(id: string): Promise<VersionRecord | null> {
  if (!isValidId(id)) return null;
  await connectToDatabase();
  const doc = await FileVersionModel.findOne({ _id: oid(id) }).lean<LeanVersion>().exec();
  return doc ? toRecord(doc) : null;
}

export async function listForFile(fileId: string): Promise<VersionRecord[]> {
  if (!isValidId(fileId)) return [];
  await connectToDatabase();
  const docs = await FileVersionModel.find({ fileId: oid(fileId) })
    .sort({ versionNumber: -1 })
    .lean<LeanVersion[]>()
    .exec();
  return docs.map(toRecord);
}

export async function findCurrent(fileId: string): Promise<VersionRecord | null> {
  if (!isValidId(fileId)) return null;
  await connectToDatabase();
  const doc = await FileVersionModel.findOne({ fileId: oid(fileId), isCurrent: true })
    .lean<LeanVersion>()
    .exec();
  return doc ? toRecord(doc) : null;
}

export async function nextVersionNumber(fileId: string): Promise<number> {
  if (!isValidId(fileId)) return 1;
  await connectToDatabase();
  const latest = await FileVersionModel.findOne({ fileId: oid(fileId) })
    .sort({ versionNumber: -1 })
    .select({ versionNumber: 1 })
    .lean<{ versionNumber: number }>()
    .exec();
  return (latest?.versionNumber ?? 0) + 1;
}

/**
 * The physical location of a version's bytes.
 *
 * Named to be conspicuous: every call site is a place where the application is about to
 * leave the metadata world and touch storage, and each one must have already checked
 * permission.
 */
/**
 * Reads the version's `storageProvider`, defaulting to `local`.
 *
 * Every version document written before the Google Drive migration lacks the field
 * entirely, and those files must keep working with no backfill — so "absent" is a
 * supported value here, resolved once, at the only place storage locations are read.
 */
function providerOf(value: unknown): StorageProviderName {
  return value === 'google_drive' ? 'google_drive' : 'local';
}

export interface VersionStorageLocation extends StorageLocator {
  mimeType: string;
  size: number;
  filename: string;
  /**
   * A Google-native document — a Doc, Sheet or Slide. It has no stored bytes at all and
   * cannot be read; it can only be *exported* to a chosen format.
   */
  isGoogleNative: boolean;
  googleNativeKind: GoogleNativeKind | null;
  /**
   * Drive's own URL for the object.
   *
   * On the locator rather than on `VersionRecord` on purpose: it identifies a location, so
   * it belongs with the other things that must never be serialized into a file listing. The
   * one code path that hands it to a browser is the native-editor redirect, which checks
   * permission first and never puts it in a response body.
   */
  webViewLink: string | null;
  /**
   * Whether the local copy is still on this server.
   *
   * Carried on the locator because it is what makes a missing Drive object survivable: the
   * local key is never cleared, so if the state is `present` a read can fall back to it
   * rather than failing. See `stored-content.ts`.
   */
  localCopyState: LocalCopyState;
}

export async function getStorageLocation(
  versionId: string,
): Promise<VersionStorageLocation | null> {
  if (!isValidId(versionId)) return null;
  await connectToDatabase();
  const doc = await FileVersionModel.findOne({ _id: oid(versionId) })
    .select({
      storageKey: 1,
      storageArea: 1,
      storageProvider: 1,
      googleDriveFileId: 1,
      googleDriveRevisionId: 1,
      googleDriveWebViewLink: 1,
      isGoogleNative: 1,
      googleNativeKind: 1,
      localCopyState: 1,
      mimeType: 1,
      fileSize: 1,
      originalFilename: 1,
    })
    .lean<{
      storageKey: string;
      storageArea: string;
      storageProvider?: string;
      googleDriveFileId?: string | null;
      googleDriveRevisionId?: string | null;
      googleDriveWebViewLink?: string | null;
      isGoogleNative?: boolean;
      googleNativeKind?: string | null;
      localCopyState?: string;
      mimeType: string;
      fileSize: number;
      originalFilename: string;
    }>()
    .exec();
  if (!doc) return null;
  return {
    provider: providerOf(doc.storageProvider),
    key: doc.storageKey,
    area: doc.storageArea as StorageArea,
    ...(doc.googleDriveFileId ? { externalId: doc.googleDriveFileId } : {}),
    ...(doc.googleDriveRevisionId ? { externalRevisionId: doc.googleDriveRevisionId } : {}),
    mimeType: doc.mimeType,
    size: doc.fileSize,
    filename: doc.originalFilename,
    isGoogleNative: doc.isGoogleNative === true,
    googleNativeKind: (doc.googleNativeKind as GoogleNativeKind | null | undefined) ?? null,
    webViewLink: doc.googleDriveWebViewLink ?? null,
    // Absent on every document written before the migration, and those all still have
    // their bytes — so absent means present, not unknown.
    localCopyState: (doc.localCopyState as LocalCopyState | undefined) ?? 'present',
  };
}

/**
 * What the change feed needs to decide what a Drive event means for one of our versions.
 *
 * Deliberately a distinct shape from `VersionRecord` and from `VersionStorageLocation`: this
 * is the only caller that starts from a *Drive* id and works backwards, and it needs the
 * stored remote state to compare against — which neither of the others carries, and neither
 * should start carrying just because one caller wants it.
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

export async function findByDriveFileId(
  googleDriveFileId: string,
): Promise<VersionByDriveId | null> {
  if (!googleDriveFileId) return null;
  await connectToDatabase();

  const doc = await FileVersionModel.findOne({ googleDriveFileId })
    .select({
      fileId: 1,
      versionNumber: 1,
      isCurrent: 1,
      isApproved: 1,
      storageProvider: 1,
      googleDriveParentId: 1,
      googleDriveRevisionId: 1,
      googleDriveMd5: 1,
      googleDriveModifiedTime: 1,
      isGoogleNative: 1,
    })
    .lean<{
      _id: Types.ObjectId;
      fileId: Types.ObjectId;
      versionNumber: number;
      isCurrent?: boolean;
      isApproved?: boolean;
      storageProvider?: string;
      googleDriveParentId?: string | null;
      googleDriveRevisionId?: string | null;
      googleDriveMd5?: string | null;
      googleDriveModifiedTime?: Date | null;
      isGoogleNative?: boolean;
    }>()
    .exec();

  if (!doc) return null;

  return {
    versionId: String(doc._id),
    fileId: String(doc.fileId),
    versionNumber: doc.versionNumber,
    isCurrent: doc.isCurrent === true,
    isApproved: doc.isApproved === true,
    storageProvider: providerOf(doc.storageProvider),
    googleDriveParentId: doc.googleDriveParentId ?? null,
    googleDriveRevisionId: doc.googleDriveRevisionId ?? null,
    googleDriveMd5: doc.googleDriveMd5 ?? null,
    googleDriveModifiedTime: doc.googleDriveModifiedTime ?? null,
    isGoogleNative: doc.isGoogleNative === true,
  };
}

/** Every Drive-backed version, for the full reconcile after an expired cursor. */
export async function listDriveBackedVersions(input: {
  limit: number;
  afterId?: string | null;
}): Promise<Array<{ versionId: string; fileId: string; googleDriveFileId: string }>> {
  await connectToDatabase();

  const filter: FilterQuery<FileVersionDocument> = {
    storageProvider: 'google_drive',
    googleDriveFileId: { $type: 'string' },
  };
  if (input.afterId && isValidId(input.afterId)) {
    (filter as Record<string, unknown>)._id = { $gt: oid(input.afterId) };
  }

  const docs = await FileVersionModel.find(filter)
    .sort({ _id: 1 })
    .limit(Math.max(1, Math.min(input.limit, 500)))
    .select({ fileId: 1, googleDriveFileId: 1 })
    .lean<Array<{ _id: Types.ObjectId; fileId: Types.ObjectId; googleDriveFileId: string }>>()
    .exec();

  return docs.map((doc) => ({
    versionId: String(doc._id),
    fileId: String(doc.fileId),
    googleDriveFileId: doc.googleDriveFileId,
  }));
}

/** Versions whose stored object disagrees with Drive. The admin conflict list. */
export async function countSyncConflicts(): Promise<number> {
  await connectToDatabase();
  return FileVersionModel.countDocuments({ syncStatus: 'conflict' }).exec();
}

/**
 * What an approval on this version was granted against.
 *
 * Separate from `VersionRecord` for the same reason `getStorageLocation` is: it returns
 * identifiers that must not travel to a browser, and keeping it a distinct, explicitly
 * named call means every use of one is visible in review.
 */
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

const APPROVAL_BINDING_FIELDS = {
  fileId: 1,
  versionNumber: 1,
  isApproved: 1,
  approvedAt: 1,
  approvedBy: 1,
  approvedRevisionId: 1,
  approvedContentModifiedAt: 1,
  approvalSupersededAt: 1,
} as const;

type LeanApprovalBinding = {
  _id: Types.ObjectId;
  fileId: Types.ObjectId;
  versionNumber: number;
  isApproved?: boolean;
  approvedAt?: Date | null;
  approvedBy?: Types.ObjectId | null;
  approvedRevisionId?: string | null;
  approvedContentModifiedAt?: Date | null;
  approvalSupersededAt?: Date | null;
};

function toApprovalBinding(doc: LeanApprovalBinding): VersionApprovalBinding {
  return {
    versionId: String(doc._id),
    fileId: String(doc.fileId),
    versionNumber: doc.versionNumber,
    isApproved: doc.isApproved === true,
    approvedAt: doc.approvedAt ?? null,
    approvedBy: doc.approvedBy ? String(doc.approvedBy) : null,
    approvedRevisionId: doc.approvedRevisionId ?? null,
    approvedContentModifiedAt: doc.approvedContentModifiedAt ?? null,
    approvalSupersededAt: doc.approvalSupersededAt ?? null,
  };
}

export async function getApprovalBinding(
  versionId: string,
): Promise<VersionApprovalBinding | null> {
  if (!isValidId(versionId)) return null;
  await connectToDatabase();
  const doc = await FileVersionModel.findOne({ _id: oid(versionId) })
    .select(APPROVAL_BINDING_FIELDS)
    .lean<LeanApprovalBinding>()
    .exec();
  return doc ? toApprovalBinding(doc) : null;
}

/**
 * Live approvals whose content lives in Drive — the sweep's work list.
 *
 * Paged by `_id` rather than by skip so a long run cannot miss a row because an earlier one
 * stopped matching the filter part-way through. Rows already marked superseded are excluded:
 * once an approval is known to be stale, re-checking it every cycle would spend a Drive call
 * per file per run to re-learn something already recorded and already acted on.
 */
export async function listLiveRemoteApprovals(input: {
  limit: number;
  afterId?: string | null;
}): Promise<VersionApprovalBinding[]> {
  await connectToDatabase();

  const filter: FilterQuery<FileVersionDocument> = {
    isApproved: true,
    storageProvider: 'google_drive',
    approvalSupersededAt: null,
  };
  if (input.afterId && isValidId(input.afterId)) {
    (filter as Record<string, unknown>)._id = { $gt: oid(input.afterId) };
  }

  const docs = await FileVersionModel.find(filter)
    .sort({ _id: 1 })
    .limit(Math.max(1, Math.min(input.limit, 500)))
    .select(APPROVAL_BINDING_FIELDS)
    .lean<LeanApprovalBinding[]>()
    .exec();

  return docs.map(toApprovalBinding);
}

/** How many live approvals are bound to remote content. For the admin System page. */
export async function countLiveRemoteApprovals(): Promise<number> {
  await connectToDatabase();
  return FileVersionModel.countDocuments({
    isApproved: true,
    storageProvider: 'google_drive',
    approvalSupersededAt: null,
  }).exec();
}

/** How many approvals have been found stale and not yet re-reviewed. */
export async function countSupersededApprovals(): Promise<number> {
  await connectToDatabase();
  return FileVersionModel.countDocuments({ approvalSupersededAt: { $ne: null } }).exec();
}

/**
 * Records that this version's stored object disagrees with what the database believes.
 *
 * Deliberately never deletes or hides the record (§16 of the brief): a file that has
 * vanished from Drive still has metadata, comments, reviews, approvals and an audit history
 * that must survive, and it may still be readable from the retained local copy. Marking it
 * is what puts it in front of an administrator; removing it would destroy the evidence.
 */
export async function markStorageConflict(
  versionId: string,
  reason: string,
): Promise<void> {
  if (!isValidId(versionId)) return;
  await connectToDatabase();
  await FileVersionModel.updateOne(
    { _id: oid(versionId) },
    { $set: { syncStatus: 'conflict', migrationFailureReason: reason.slice(0, 500) } },
  ).exec();
}

export async function getStorageLocationsForFiles(
  fileIds: string[],
): Promise<StorageLocator[]> {
  const valid = fileIds.filter(isValidId).map(oid);
  if (valid.length === 0) return [];
  await connectToDatabase();
  const docs = await FileVersionModel.find({ fileId: { $in: valid } })
    .select({ storageKey: 1, storageArea: 1, storageProvider: 1, googleDriveFileId: 1 })
    .lean<
      Array<{
        storageKey: string;
        storageArea: string;
        storageProvider?: string;
        googleDriveFileId?: string | null;
      }>
    >()
    .exec();
  return docs.map((doc) => ({
    provider: providerOf(doc.storageProvider),
    key: doc.storageKey,
    area: doc.storageArea as StorageArea,
    ...(doc.googleDriveFileId ? { externalId: doc.googleDriveFileId } : {}),
  }));
}

export interface StoredObjectRef extends StorageLocator {
  versionId: string;
  fileId: string;
  fileSize: number;
  checksumSha256: string;
}

/**
 * Every stored object, in `_id` order, one page at a time.
 *
 * The integrity sweep has to walk the whole collection on a volume that may hold
 * hundreds of thousands of versions, so it pages by `_id` rather than by skip: a skip
 * over a growing collection re-reads and misses rows as it goes.
 */
export async function listStoredObjects(input: {
  afterId?: string;
  limit: number;
}): Promise<StoredObjectRef[]> {
  await connectToDatabase();

  const filter: FilterQuery<FileVersionDocument> = {};
  if (input.afterId && isValidId(input.afterId)) filter._id = { $gt: oid(input.afterId) };

  const docs = await FileVersionModel.find(filter)
    .select({
      fileId: 1,
      storageKey: 1,
      storageArea: 1,
      storageProvider: 1,
      googleDriveFileId: 1,
      fileSize: 1,
      checksumSha256: 1,
    })
    .sort({ _id: 1 })
    .limit(input.limit)
    .lean<
      Array<{
        _id: Types.ObjectId;
        fileId: Types.ObjectId;
        storageKey: string;
        storageArea: string;
        storageProvider?: string;
        googleDriveFileId?: string | null;
        fileSize: number;
        checksumSha256: string;
      }>
    >()
    .exec();

  return docs.map((doc) => ({
    versionId: String(doc._id),
    fileId: String(doc.fileId),
    provider: providerOf(doc.storageProvider),
    key: doc.storageKey,
    area: doc.storageArea as StorageArea,
    ...(doc.googleDriveFileId ? { externalId: doc.googleDriveFileId } : {}),
    fileSize: doc.fileSize,
    checksumSha256: doc.checksumSha256,
  }));
}

export async function countStoredObjects(): Promise<number> {
  await connectToDatabase();
  return FileVersionModel.countDocuments({}).exec();
}

export interface CreateVersionInput {
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
   * Where the bytes are, when the caller wrote them somewhere other than local storage.
   *
   * Set by the server-side copy path, which creates its object directly in Drive. Left
   * unset by the ordinary upload, whose bytes really are local.
   */
  storageProvider?: 'local' | 'google_drive';
  googleDriveFileId?: string | null;
  googleDriveParentId?: string | null;
  googleDriveRevisionId?: string | null;
  googleDriveMd5?: string | null;
  googleDriveWebViewLink?: string | null;
  /**
   * Only the Drive import sets this, to the source file's modified time. "Uploaded at"
   * for an imported file means "this is when the research actually happened", not when
   * the migration ran.
   */
  uploadedAt?: Date;
}

export async function create(
  input: CreateVersionInput,
  session?: ClientSession,
): Promise<VersionRecord> {
  await connectToDatabase();
  const [doc] = await FileVersionModel.create(
    [
      {
        organizationId: oid(input.organizationId),
        fileId: oid(input.fileId),
        versionNumber: input.versionNumber,
        storageKey: input.storageKey,
        storageArea: input.storageArea,
        relativeStoragePath: input.relativeStoragePath,
        storedFilename: input.storedFilename,
        originalFilename: input.originalFilename,
        fileSize: input.fileSize,
        mimeType: input.mimeType,
        extension: input.extension,
        checksumSha256: input.checksumSha256,
        uploadedBy: oid(input.uploadedBy),
        uploadedAt: input.uploadedAt ?? new Date(),
        versionNote: input.versionNote ?? '',
        restoredFromVersionId: input.restoredFromVersionId
          ? oid(input.restoredFromVersionId)
          : null,
        processingStatus: 'ready',
        label: 'draft',
        isCurrent: true,
        /**
         * Where the bytes actually are, when the caller already knows.
         *
         * A server-side Drive copy writes its object in Drive and never touches local
         * storage, so recording only `storageKey` would leave the new version pointing at a
         * local path that was never written — a file that reads as present and downloads as
         * nothing. Omitted by the ordinary upload path, which defaults to local because
         * that is where its bytes genuinely are.
         */
        ...(input.storageProvider ? { storageProvider: input.storageProvider } : {}),
        ...(input.googleDriveFileId
          ? {
              googleDriveFileId: input.googleDriveFileId,
              googleDriveParentId: input.googleDriveParentId ?? null,
              googleDriveRevisionId: input.googleDriveRevisionId ?? null,
              googleDriveMd5: input.googleDriveMd5 ?? null,
              googleDriveWebViewLink: input.googleDriveWebViewLink ?? null,
              migrationStatus: 'verified',
              migratedAt: new Date(),
              syncStatus: 'synced',
              lastSyncedAt: new Date(),
              // No local copy was ever written for a server-side copy, so there is nothing
              // to retain and nothing to fall back to. Saying so is what stops Phase 4's
              // fallback reaching for bytes that do not exist.
              localCopyState: 'deleted',
            }
          : {}),
      },
    ],
    session ? { session } : undefined,
  );
  return toRecord(doc!.toObject() as LeanVersion);
}

/**
 * Makes one version current and demotes the rest.
 *
 * The demoted version keeps its own label unless it was the plain working draft — an
 * approved version that is superseded stays visibly approved in the history, because
 * "which version did they sign?" must remain answerable forever.
 */
export async function setCurrent(
  fileId: string,
  versionId: string,
  session?: ClientSession,
): Promise<void> {
  await connectToDatabase();
  const sessionOption = session ? { session } : {};

  await FileVersionModel.updateMany(
    { fileId: oid(fileId), _id: { $ne: oid(versionId) }, isCurrent: true },
    { $set: { isCurrent: false } },
    sessionOption,
  ).exec();

  await FileVersionModel.updateMany(
    { fileId: oid(fileId), _id: { $ne: oid(versionId) }, label: 'draft' },
    { $set: { label: 'superseded' } },
    sessionOption,
  ).exec();

  await FileVersionModel.updateOne(
    { _id: oid(versionId) },
    { $set: { isCurrent: true } },
    sessionOption,
  ).exec();
}

export async function updateFlags(
  versionId: string,
  update: Record<string, unknown>,
  session?: ClientSession,
): Promise<void> {
  await connectToDatabase();
  const query = FileVersionModel.updateOne({ _id: oid(versionId) }, update);
  if (session) query.session(session);
  await query.exec();
}

export async function purgeForFiles(fileIds: string[]): Promise<number> {
  const valid = fileIds.filter(isValidId).map(oid);
  if (valid.length === 0) return 0;
  await connectToDatabase();
  const result = await FileVersionModel.deleteMany({ fileId: { $in: valid } }).exec();
  return result.deletedCount ?? 0;
}
