/**
 * One Drive file, and what happened to it.
 *
 * This is the migration report. Every file that was scanned gets a row whether it was
 * imported, skipped or failed, and the row keeps the Drive id — so "was this ever
 * imported, and where did it go?" is answerable years later, which is what the brief
 * means by "every migration item has an audit history".
 *
 * `(jobId, driveFileId)` is unique. That is what makes a re-scan idempotent: scanning the
 * same folder twice updates rows rather than importing everything a second time.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';

export const MIGRATION_ITEM_STATUSES = [
  'pending',
  'importing',
  'imported',
  'skipped_duplicate',
  'skipped_unsupported',
  'needs_review',
  'failed',
] as const;
export type MigrationItemStatus = (typeof MIGRATION_ITEM_STATUSES)[number];

const migrationItemSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'MigrationJob', required: true },

    /** Preserved verbatim: the link back to the untouched original. */
    driveFileId: { type: String, required: true, maxlength: 200 },
    driveParentId: { type: String, default: null, maxlength: 200 },
    /** Source path as it read in Drive, for the report. Display only. */
    sourcePath: { type: String, default: '', maxlength: 2000 },

    name: { type: String, required: true, maxlength: 500 },
    mimeType: { type: String, default: '', maxlength: 200 },
    /** Drive's own size. Advisory — the imported size is what this server measured. */
    declaredSize: { type: Number, default: 0, min: 0 },
    /** Drive's MD5, where it has one. Used as a *hint*, never as proof of equality. */
    driveMd5: { type: String, default: null, maxlength: 64 },
    driveCreatedTime: { type: Date, default: null },
    driveModifiedTime: { type: Date, default: null },
    /** True for Google Docs/Sheets/Slides, which have to be exported rather than downloaded. */
    isGoogleNative: { type: Boolean, default: false },

    status: { type: String, enum: MIGRATION_ITEM_STATUSES, default: 'pending' },
    /** The folder this item was (or will be) imported into. */
    targetFolderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
    resultFileId: { type: Schema.Types.ObjectId, ref: 'File', default: null },
    resultVersionId: { type: Schema.Types.ObjectId, ref: 'FileVersion', default: null },
    /** Measured here while streaming, not taken from Drive. */
    checksumSha256: { type: String, default: null, maxlength: 64 },
    importedBytes: { type: Number, default: 0, min: 0 },

    /** Set when the bytes already existed — points at the file they matched. */
    duplicateOfFileId: { type: Schema.Types.ObjectId, ref: 'File', default: null },

    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: null, maxlength: 1000 },
    importedAt: { type: Date, default: null },
  },
  baseSchemaOptions,
);

migrationItemSchema.index({ jobId: 1, driveFileId: 1 }, { unique: true });
migrationItemSchema.index({ jobId: 1, status: 1, _id: 1 });
migrationItemSchema.index({ organizationId: 1, driveFileId: 1 });
migrationItemSchema.index({ resultFileId: 1 });

export type MigrationItemDocument = InferSchemaType<typeof migrationItemSchema>;

export const MigrationItemModel: Model<MigrationItemDocument> =
  (models.MigrationItem as Model<MigrationItemDocument>) ??
  model<MigrationItemDocument>('MigrationItem', migrationItemSchema);
