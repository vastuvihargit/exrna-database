/**
 * A Google Drive migration.
 *
 * One job is one administrator's decision: *these* Drive folders, into *that* destination
 * folder, with this classification. It holds the connection, the counters and the state
 * machine; the per-file record is `MigrationItem`.
 *
 * The refresh token is stored encrypted (`connection.refreshTokenCipher`) and is the only
 * secret in this collection. It is excluded from `toJSON` by name, and the migration DTO
 * has no field to put it in — so a serialization mistake cannot leak the credential that
 * reads the company's entire Drive.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions, softDeleteFields, CONFIDENTIALITY_LEVELS } from '@/server/db/base-schema';

/**
 * The states from §18 of the brief.
 *
 * `needs_review` is not a failure: it is "imported, but some items were skipped or
 * flagged and a human should look before this is called done".
 */
export const MIGRATION_STATUSES = [
  'draft',
  'connected',
  'scanning',
  'scanned',
  'importing',
  'paused',
  'needs_review',
  'partially_completed',
  'completed',
  'failed',
] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

const counterFields = {
  scannedFiles: { type: Number, default: 0, min: 0 },
  scannedFolders: { type: Number, default: 0, min: 0 },
  scannedBytes: { type: Number, default: 0, min: 0 },
  imported: { type: Number, default: 0, min: 0 },
  importedBytes: { type: Number, default: 0, min: 0 },
  skippedDuplicates: { type: Number, default: 0, min: 0 },
  skippedUnsupported: { type: Number, default: 0, min: 0 },
  failed: { type: Number, default: 0, min: 0 },
} as const;

const migrationJobSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 2000 },

    status: { type: String, enum: MIGRATION_STATUSES, default: 'draft' },

    /** Where imported content lands. Always an existing folder in this platform. */
    targetFolderId: { type: Schema.Types.ObjectId, ref: 'Folder', required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    /** Applied to every imported file. Never weaker than the destination folder's. */
    confidentiality: { type: String, enum: CONFIDENTIALITY_LEVELS, default: 'internal' },

    /** Drive folder ids selected by the administrator. Empty means "My Drive root". */
    sourceFolderIds: { type: [String], default: [] },

    connection: {
      /** The Google account that authorized the read. Shown so the source is auditable. */
      accountEmail: { type: String, default: null, maxlength: 320 },
      /** AES-256-GCM. Never serialized — see the note at the top of this file. */
      refreshTokenCipher: { type: String, default: null, maxlength: 4000 },
      scope: { type: String, default: null, maxlength: 500 },
      connectedAt: { type: Date, default: null },
      connectedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    },

    options: {
      /** Recreate the Drive folder tree under the destination. */
      preserveHierarchy: { type: Boolean, default: true },
      /** Use Drive's created/modified times on the imported records. */
      preserveDates: { type: Boolean, default: true },
      /** Skip a file whose bytes already exist in this organization. */
      skipDuplicates: { type: Boolean, default: true },
      /** Convert Google Docs/Sheets/Slides to Office formats rather than skipping them. */
      exportGoogleDocs: { type: Boolean, default: true },
    },

    counters: counterFields,

    scanStartedAt: { type: Date, default: null },
    scanCompletedAt: { type: Date, default: null },
    importStartedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    /** Set when a run stops early; cleared when it is resumed. */
    lastError: { type: String, default: null, maxlength: 1000 },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ...softDeleteFields,
  },
  baseSchemaOptions,
);

migrationJobSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
migrationJobSchema.index({ createdBy: 1, createdAt: -1 });

migrationJobSchema.set('toJSON', {
  ...baseSchemaOptions.toJSON,
  transform(doc, ret: Record<string, unknown>) {
    const base = baseSchemaOptions.toJSON.transform(doc, ret);
    const connection = base.connection as Record<string, unknown> | undefined;
    if (connection) delete connection.refreshTokenCipher;
    return base;
  },
});

export type MigrationJobDocument = InferSchemaType<typeof migrationJobSchema>;

export const MigrationJobModel: Model<MigrationJobDocument> =
  (models.MigrationJob as Model<MigrationJobDocument>) ??
  model<MigrationJobDocument>('MigrationJob', migrationJobSchema);
