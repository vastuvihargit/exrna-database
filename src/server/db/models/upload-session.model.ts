/**
 * An upload in progress.
 *
 * Exists so that an upload is a *transaction* rather than a request: the permission
 * check, the quota reservation and the type decision all happen before a single byte is
 * accepted, and the session is what the client resumes against if the connection drops.
 *
 * `finalizationKey` makes finalization idempotent. A client that retries after a
 * timeout must not produce two files from one upload — the brief calls this out
 * explicitly, and it is the failure mode that silently duplicates research data.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';

export const UPLOAD_STATUSES = [
  'pending',
  'uploading',
  'processing',
  'quarantined',
  'ready',
  'failed',
  'rejected',
  'aborted',
] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

const uploadSessionSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    folderId: { type: Schema.Types.ObjectId, ref: 'Folder', required: true },
    /** Set when this upload is a new version of an existing file. */
    targetFileId: { type: Schema.Types.ObjectId, ref: 'File', default: null },

    declaredFilename: { type: String, required: true, maxlength: 300 },
    /** Sanitized display name derived from the declared filename. */
    displayName: { type: String, required: true, maxlength: 300 },
    extension: { type: String, required: true, lowercase: true, maxlength: 20 },
    declaredSize: { type: Number, required: true, min: 0 },
    declaredMimeType: { type: String, default: null, maxlength: 200 },
    resolvedMimeType: { type: String, required: true, maxlength: 200 },
    versionNote: { type: String, default: '', maxlength: 1000 },

    status: { type: String, enum: UPLOAD_STATUSES, default: 'pending' },
    receivedBytes: { type: Number, default: 0, min: 0 },
    /** Zero for a single-shot upload; set when the client opts into chunking. */
    chunkSize: { type: Number, default: 0, min: 0 },
    totalChunks: { type: Number, default: 0, min: 0 },
    receivedChunks: { type: [Number], default: [] },

    /** Where the bytes sit while they are still untrusted. */
    quarantineKey: { type: String, default: null, maxlength: 500 },
    checksumSha256: { type: String, default: null, maxlength: 64 },

    resultFileId: { type: Schema.Types.ObjectId, ref: 'File', default: null },
    resultVersionId: { type: Schema.Types.ObjectId, ref: 'FileVersion', default: null },
    failureReason: { type: String, default: null, maxlength: 500 },

    /** Set once on the first successful finalization; a retry returns the same result. */
    finalizationKey: { type: String, default: null, maxlength: 64 },
    expiresAt: { type: Date, required: true },
  },
  baseSchemaOptions,
);

uploadSessionSchema.index({ userId: 1, status: 1, createdAt: -1 });
uploadSessionSchema.index({ folderId: 1, status: 1 });
uploadSessionSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
/**
 * No TTL index: an abandoned upload holds bytes in quarantine, and deleting the record
 * without deleting the file would strand them. The cleanup job removes both, in order.
 */
uploadSessionSchema.index({ expiresAt: 1 });

export type UploadSessionDocument = InferSchemaType<typeof uploadSessionSchema>;

export const UploadSessionModel: Model<UploadSessionDocument> =
  (models.UploadSession as Model<UploadSessionDocument>) ??
  model<UploadSessionDocument>('UploadSession', uploadSessionSchema);
