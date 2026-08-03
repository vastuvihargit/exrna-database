/**
 * An immutable version — the only document that knows where bytes actually are.
 *
 * `storageKey`, `relativeStoragePath` and `storedFilename` are in the global
 * `ALWAYS_HIDDEN` list in base-schema, so they are stripped from every `toJSON()`.
 * The DTO layer omits them as well: two independent barriers, because a physical path
 * reaching a browser is the failure this whole design exists to prevent.
 *
 * Versions are never updated in place except for their review flags. A correction is a
 * new version, which is what makes "which one did they approve?" answerable.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';
import { ACTIONABLE_SYNC_STATUSES, driveObjectFields } from '@/server/db/storage-fields';

export const PROCESSING_STATUSES = [
  'pending',
  'uploading',
  'processing',
  'quarantined',
  'ready',
  'failed',
  'rejected',
  'archived',
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

/** Lifecycle label shown in the version list. */
export const VERSION_LABELS = [
  'draft',
  'under_review',
  'changes_requested',
  'approved',
  'final',
  'superseded',
  'archived',
] as const;
export type VersionLabel = (typeof VERSION_LABELS)[number];

const fileVersionSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    fileId: { type: Schema.Types.ObjectId, ref: 'File', required: true },
    versionNumber: { type: Number, required: true, min: 1 },

    /** Internal only — never serialized, never returned by an API. */
    storageKey: { type: String, required: true, maxlength: 500 },
    storageArea: { type: String, required: true, maxlength: 40 },
    relativeStoragePath: { type: String, default: null, maxlength: 500 },
    storedFilename: { type: String, default: null, maxlength: 200 },

    originalFilename: { type: String, required: true, maxlength: 300 },
    fileSize: { type: Number, required: true, min: 0 },
    mimeType: { type: String, required: true, maxlength: 200 },
    extension: { type: String, required: true, lowercase: true, maxlength: 20 },
    /** Measured while streaming, never taken from the client. */
    checksumSha256: { type: String, required: true, maxlength: 64 },

    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedAt: { type: Date, default: Date.now },
    versionNote: { type: String, default: '', maxlength: 1000 },
    /** Set when this version was produced by restoring an older one. */
    restoredFromVersionId: { type: Schema.Types.ObjectId, ref: 'FileVersion', default: null },

    processingStatus: { type: String, enum: PROCESSING_STATUSES, default: 'pending' },
    label: { type: String, enum: VERSION_LABELS, default: 'draft' },
    isCurrent: { type: Boolean, default: false },
    isApproved: { type: Boolean, default: false },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },

    /**
     * The exact remote state an approval was granted against, and whether it still holds.
     *
     * For a locally-stored version the approval is already pinned by `checksumSha256`, which
     * cannot change because the object is immutable — these stay null and nothing needs to
     * watch them. They exist for the case that has no such guarantee: content that lives in
     * Google Drive, where a Doc can be rewritten by anyone with the link and the bytes under
     * an approval can change without this application being involved at all.
     *
     * `approvedRevisionId` is captured when the approval closes. `approvalSupersededAt` is
     * set when a later check finds the remote content no longer matches it — the approval is
     * marked stale, never erased, because who signed what and when is the record the whole
     * review system exists to keep.
     */
    approvedRevisionId: { type: String, default: null, maxlength: 200 },
    approvedContentModifiedAt: { type: Date, default: null },
    approvalSupersededAt: { type: Date, default: null },
    approvalSupersededReason: { type: String, default: null, maxlength: 300 },

    /** Set once a preview has been generated for this version (Phase 5). */
    previewKey: { type: String, default: null, maxlength: 500 },
    previewStatus: { type: String, enum: ['none', 'pending', 'ready', 'unsupported', 'failed'], default: 'none' },

    /**
     * Where the bytes live externally, and how far through migration this version is.
     *
     * Every field defaults, so the documents written before this existed remain valid and
     * read back as local / not_started / not_required with no backfill. `storageKey` above
     * is untouched: after migration a version carries *both* addresses, which is what makes
     * a rollback a single field change rather than moving data back.
     */
    ...driveObjectFields,
  },
  baseSchemaOptions,
);

fileVersionSchema.index({ fileId: 1, versionNumber: -1 }, { unique: true });
fileVersionSchema.index({ fileId: 1, isCurrent: 1 });
fileVersionSchema.index({ storageKey: 1 }, { unique: true });
fileVersionSchema.index({ checksumSha256: 1 });
fileVersionSchema.index({ organizationId: 1, processingStatus: 1, createdAt: -1 });

/**
 * **The hard guarantee against duplicate uploads on retry.**
 *
 * Unique and partial, so it constrains only the rows that have actually been migrated. A
 * retry that would record a second Drive file for the same version fails *at the database*
 * rather than relying on the worker's own bookkeeping — which is the layer that is by
 * definition unavailable when the worker has just crashed.
 */
fileVersionSchema.index(
  { googleDriveFileId: 1 },
  { unique: true, partialFilterExpression: { googleDriveFileId: { $type: 'string' } } },
);

/** The migration worker's cursor: "next N unmigrated versions, in a stable order". */
fileVersionSchema.index({ storageProvider: 1, migrationStatus: 1, _id: 1 });

/**
 * Only the rows a sync worker would act on. `not_required` is every local object and
 * `synced` is the steady state, so excluding both keeps this index small enough to stay
 * resident however large the corpus grows.
 */
fileVersionSchema.index(
  { syncStatus: 1, lastSyncedAt: 1 },
  { partialFilterExpression: { syncStatus: { $in: [...ACTIONABLE_SYNC_STATUSES] } } },
);

/**
 * The approval-integrity sweep: "which live approvals are bound to remote content?".
 *
 * Partial on `isApproved`, so it indexes only the approvals — a small fraction of versions
 * in any real corpus, and the only rows the sweep has any reason to look at. A full index on
 * `storageProvider` would be mostly the other kind.
 */
fileVersionSchema.index(
  { storageProvider: 1, approvalSupersededAt: 1, _id: 1 },
  { partialFilterExpression: { isApproved: true } },
);

/** Drives the retention sweep: which local copies are now old enough to consider removing. */
fileVersionSchema.index(
  { localCopyState: 1, localCopyEligibleForDeletionAt: 1 },
  { partialFilterExpression: { localCopyState: 'present' } },
);

/**
 * A stored version is immutable. Only the review/approval flags and the preview fields
 * may change; anything else must be a new version.
 *
 * ── Widened in Phase 3, deliberately and narrowly ──────────────────────────────────────
 *
 * The storage-location and lifecycle fields are mutable; the **content-identity** fields
 * are not. That distinction is the entire point of this hook.
 *
 * What it exists to protect is "the bytes a reviewer approved cannot be swapped underneath
 * the approval". Recording that the same bytes now *also* live in Google Drive does not
 * touch that: `checksumSha256`, `fileSize`, `mimeType`, `extension`, `originalFilename`,
 * `versionNumber`, `fileId` and `storageKey` all remain immutable, so the identity of what
 * was approved is unchanged and still verifiable against the local copy.
 *
 * **Do not widen this further to include any of those.** A migration that could rewrite a
 * checksum could hide a corrupt transfer by simply recording the corruption as expected.
 */
const MUTABLE_PATHS = new Set([
  'processingStatus',
  'label',
  'isCurrent',
  'isApproved',
  'approvedBy',
  'approvedAt',
  // Approval binding (Phase 8). These describe the approval, not the bytes: recording that
  // an approval was granted against Drive revision X, or that X has since been superseded,
  // changes nothing about what was approved — which is still `checksumSha256`, still
  // immutable, and still the thing a mismatch is detected against.
  'approvedRevisionId',
  'approvedContentModifiedAt',
  'approvalSupersededAt',
  'approvalSupersededReason',
  'previewKey',
  'previewStatus',
  'versionNote',
  'updatedAt',
  // Storage location — where the bytes are, never what they are.
  'storageProvider',
  'googleDriveFileId',
  'googleDriveParentId',
  'googleDriveRevisionId',
  'googleDriveMd5',
  'googleDriveModifiedTime',
  'googleDriveWebViewLink',
  // Migration and sync lifecycle.
  'migrationStatus',
  'migratedAt',
  'migrationFailureReason',
  'syncStatus',
  'lastSyncedAt',
  // Local-copy retention.
  'localCopyState',
  'localCopyEligibleForDeletionAt',
  'archivedStorageKey',
  'localCopyArchivedAt',
  'localCopyDeletedAt',
  // Google-native classification, set when a native document is adopted.
  'isGoogleNative',
  'googleNativeKind',
]);

/**
 * Named so a test can assert the immutable set has not quietly grown. These are the fields
 * that answer "which bytes did they approve?", and every one of them must stay unwritable.
 */
export const IMMUTABLE_VERSION_PATHS = [
  'fileId',
  'versionNumber',
  'storageKey',
  'storageArea',
  'originalFilename',
  'fileSize',
  'mimeType',
  'extension',
  'checksumSha256',
  'uploadedBy',
] as const;

function assertOnlyMutablePaths(update: Record<string, unknown> | undefined): string | null {
  if (!update) return null;
  for (const [operator, value] of Object.entries(update)) {
    if (!operator.startsWith('$')) {
      return operator; // a whole-document replace
    }
    if (operator === '$set' || operator === '$unset' || operator === '$inc') {
      for (const path of Object.keys(value as Record<string, unknown>)) {
        if (!MUTABLE_PATHS.has(path)) return path;
      }
    }
  }
  return null;
}

for (const hook of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) {
  fileVersionSchema.pre(hook, function blockImmutableUpdate(next) {
    const offending = assertOnlyMutablePaths(this.getUpdate() as Record<string, unknown>);
    if (offending) {
      next(
        new Error(
          `File versions are immutable: "${offending}" cannot be modified. Upload a new version instead.`,
        ),
      );
      return;
    }
    next();
  });
}

export type FileVersionDocument = InferSchemaType<typeof fileVersionSchema>;

export const FileVersionModel: Model<FileVersionDocument> =
  (models.FileVersion as Model<FileVersionDocument>) ??
  model<FileVersionDocument>('FileVersion', fileVersionSchema);
