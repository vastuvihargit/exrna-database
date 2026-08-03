/**
 * The reconciliation queue for "the two sides disagree and nobody is left to fix it".
 *
 * A row is written **before** any Drive mutation and cleared **after** the matching MongoDB
 * commit. Anything still here is, by construction, an operation that got part-way — and the
 * genuinely hard case is the process dying between those two points:
 *
 *     write recovery row  →  Drive commits  →  ✗ process dies  →  MongoDB never updated
 *
 * From a restart, nothing in `FileVersion` says that upload happened. Without this row the
 * retry uploads the same bytes again, and the company's storage accumulates an orphan for
 * every crash. With it, the sweep knows to search Drive for `appProperties.idempotencyKey`
 * and adopt what it finds.
 *
 * The user is never told an operation succeeded while a row for it is open. "Probably fine"
 * is not a state this system reports.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';

/**
 * Which side of the boundary the operation was on when it stopped, and therefore what the
 * sweep should go looking for.
 */
export const RECOVERY_PHASES = [
  /** Drive write started; unknown whether it landed. Search by idempotency key. */
  'drive_write_pending',
  /** Drive write confirmed; the database update did not commit. Adopt the known id. */
  'database_write_pending',
  /** A mutation applied to Drive that MongoDB has not recorded (rename, move, trash). */
  'mutation_pending',
] as const;
export type RecoveryPhase = (typeof RECOVERY_PHASES)[number];

export const RECOVERY_STATUSES = [
  'open',
  /** Found the orphan and linked it. No bytes were re-sent. */
  'resolved_adopted',
  /** Nothing had reached Drive; the operation was safely retried from the start. */
  'resolved_retried',
  /** The partial remote object was removed and the record left at its original state. */
  'resolved_reverted',
  /** Automatic reconciliation could not decide. An administrator must look. */
  'needs_admin',
] as const;
export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];

const storageRecoveryItemSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },

    versionId: { type: Schema.Types.ObjectId, ref: 'FileVersion', default: null },
    folderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
    /** Null for an interactive upload; set when a migration job was responsible. */
    jobId: { type: Schema.Types.ObjectId, ref: 'StorageMigrationJob', default: null },

    phase: { type: String, enum: RECOVERY_PHASES, required: true },
    status: { type: String, enum: RECOVERY_STATUSES, default: 'open' },

    /** The key stamped on the Drive object. The only way to find an orphan after a crash. */
    idempotencyKey: { type: String, required: true, maxlength: 120 },
    /** Set when the Drive id was known before the database write failed. */
    observedDriveFileId: { type: String, default: null, maxlength: 200 },

    /** What the record looked like before, so a revert has something to restore to. */
    previousState: { type: Schema.Types.Mixed, default: null },

    attempts: { type: Number, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
    detail: { type: String, default: null, maxlength: 1000 },

    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  baseSchemaOptions,
);

/**
 * One open row per idempotency key. The key identifies a single logical operation, so a
 * retry that re-enters the same code path must find the existing row rather than opening a
 * second one and racing itself.
 */
storageRecoveryItemSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } },
);

/** The sweep's queue, oldest first. */
storageRecoveryItemSchema.index(
  { organizationId: 1, lastAttemptAt: 1 },
  { partialFilterExpression: { status: 'open' } },
);
/** The admin panel's "these need a human" list. */
storageRecoveryItemSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
storageRecoveryItemSchema.index({ versionId: 1 });

export type StorageRecoveryItemDocument = InferSchemaType<typeof storageRecoveryItemSchema>;

export const StorageRecoveryItemModel: Model<StorageRecoveryItemDocument> =
  (models.StorageRecoveryItem as Model<StorageRecoveryItemDocument>) ??
  model<StorageRecoveryItemDocument>('StorageRecoveryItem', storageRecoveryItemSchema);
