/**
 * One version's journey into Google Shared Drive.
 *
 * The unit of work is the **version**, not the file: a file with five versions is five
 * transfers sharing one Drive parent folder. Migrating only current versions would make
 * version history unrecoverable the moment local copies are deleted, so history is carried
 * across too and each piece of it gets a row here.
 *
 * ⚠ Not `MigrationItem` — see the header of `storage-migration-job.model.ts` for why the
 * inbound importer's collections are kept strictly separate.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';
import { IN_FLIGHT_MIGRATION_STATUSES, STORAGE_MIGRATION_STATUSES } from '@/server/db/storage-fields';

/** Machine-readable failure codes. Grouped and counted on the dashboard, never free text. */
export const STORAGE_MIGRATION_FAILURE_CODES = [
  /** The version's row exists but its bytes are not on disk. */
  'LOCAL_MISSING',
  /** The bytes on disk no longer hash to what the database recorded — local bit-rot. */
  'LOCAL_CORRUPT',
  /** Drive's own checksum disagreed with what we sent. The remote object was deleted. */
  'VERIFY_MISMATCH',
  'DRIVE_UPLOAD_FAILED',
  'DRIVE_QUOTA_EXCEEDED',
  'DRIVE_PERMISSION_DENIED',
  'DRIVE_RATE_LIMITED',
  /** The mirrored folder could not be created, so there was nowhere to put the file. */
  'FOLDER_MAPPING_FAILED',
  /** Deeper than Drive's 20-level ceiling; reported by a dry run before anything moves. */
  'FOLDER_TOO_DEEP',
  /** Bytes reached Drive but the database write did not. Handed to the recovery queue. */
  'DATABASE_WRITE_FAILED',
  'CANCELLED',
  'UNKNOWN',
] as const;
export type StorageMigrationFailureCode = (typeof STORAGE_MIGRATION_FAILURE_CODES)[number];

const storageMigrationItemSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'StorageMigrationJob', required: true },

    versionId: { type: Schema.Types.ObjectId, ref: 'FileVersion', required: true },
    /** Denormalized so the dashboard can list items without joining two collections. */
    fileId: { type: Schema.Types.ObjectId, ref: 'File', required: true },
    folderId: { type: Schema.Types.ObjectId, ref: 'Folder', required: true },
    displayName: { type: String, default: '', maxlength: 300 },
    versionNumber: { type: Number, default: 1, min: 1 },
    sizeBytes: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: STORAGE_MIGRATION_STATUSES, default: 'not_started' },

    /**
     * True for exactly the statuses in which a transfer is in flight, maintained by the
     * same write that sets `status`. It exists to key the unique index below on a simple
     * equality rather than a status list, so the constraint cannot drift if the status
     * vocabulary ever grows.
     */
    claimActive: { type: Boolean, default: false },
    claimedAt: { type: Date, default: null },
    /** Identifies the worker holding the claim, so a stale one can be reclaimed. */
    claimedBy: { type: String, default: null, maxlength: 100 },

    /**
     * Stamped onto the Drive object as `appProperties.idempotencyKey` before the upload
     * begins. This is what lets a file orphaned by a crash between "Drive committed" and
     * "MongoDB committed" be found by a `files.list` query and adopted, rather than
     * uploaded a second time.
     */
    idempotencyKey: { type: String, required: true, maxlength: 120 },

    /** What was actually created. Null until the upload returns. */
    googleDriveFileId: { type: String, default: null, maxlength: 200 },
    googleDriveParentId: { type: String, default: null, maxlength: 200 },

    /** Computed off local disk in the same streaming pass as the transfer. */
    localSha256: { type: String, default: null, maxlength: 64 },
    localMd5: { type: String, default: null, maxlength: 32 },
    /** Drive's own value, compared against `localMd5` to prove the round trip. */
    remoteMd5: { type: String, default: null, maxlength: 32 },
    checksumVerified: { type: Boolean, default: false },

    attempts: { type: Number, default: 0, min: 0 },
    failureCode: { type: String, enum: [...STORAGE_MIGRATION_FAILURE_CODES, null], default: null },
    failureDetail: { type: String, default: null, maxlength: 1000 },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    transferMs: { type: Number, default: null },
  },
  baseSchemaOptions,
);

/** One row per version per job. Re-planning a job is therefore idempotent. */
storageMigrationItemSchema.index({ jobId: 1, versionId: 1 }, { unique: true });

/**
 * **Two jobs cannot transfer the same version at the same time.**
 *
 * Unique across the whole collection — not per job — and partial on the in-flight flag, so
 * it constrains only the handful of rows actually moving at any moment. Without this, an
 * administrator who starts an overlapping job while another is running gets two workers
 * uploading the same bytes to two different Drive files, and only one of them can win the
 * unique index on `FileVersion.googleDriveFileId`. The other leaves an orphan.
 */
storageMigrationItemSchema.index(
  { versionId: 1 },
  { unique: true, partialFilterExpression: { claimActive: true } },
);

/** The worker's queue: the next pending items of this job, in a stable order. */
storageMigrationItemSchema.index({ jobId: 1, status: 1, _id: 1 });
/** The dashboard's failure list, grouped by code. */
storageMigrationItemSchema.index({ jobId: 1, failureCode: 1 });
/** "Has this version ever been migrated, by any job?" — used when planning a new one. */
storageMigrationItemSchema.index({ versionId: 1, status: 1 });
/** Finds claims abandoned by a worker that died, so they can be released. */
storageMigrationItemSchema.index(
  { claimedAt: 1 },
  { partialFilterExpression: { claimActive: true } },
);

export const IN_FLIGHT_STATUSES = IN_FLIGHT_MIGRATION_STATUSES;

export type StorageMigrationItemDocument = InferSchemaType<typeof storageMigrationItemSchema>;

export const StorageMigrationItemModel: Model<StorageMigrationItemDocument> =
  (models.StorageMigrationItem as Model<StorageMigrationItemDocument>) ??
  model<StorageMigrationItemDocument>('StorageMigrationItem', storageMigrationItemSchema);
